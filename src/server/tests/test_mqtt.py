"""Tests for the embedded MQTT broker, auth plugin, and message handler."""

from __future__ import annotations

import asyncio
import json
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import server.mqtt as mqtt_module
from server.mqtt import MQTT_SOURCE, BrokerContext
from server.rate_limit import SlidingWindowLimiter


@pytest.fixture()
def mock_write_api() -> MagicMock:
    api = MagicMock()
    api.write = AsyncMock(return_value=True)
    return api


@pytest.fixture()
def settings() -> MagicMock:
    s = MagicMock()
    s.influx_bucket = "metrics"
    s.influx_org = "mallard"
    s.mqtt_port = 8083
    s.mqtt_topic_prefix = "mallard/"
    s.rate_limit = "1000/minute"
    return s


def _limiter(spec: str = "1000/minute") -> SlidingWindowLimiter:
    return SlidingWindowLimiter.from_string(spec)


@pytest.fixture()
def static_verifier():
    """StaticCredentialVerifier with shared MQTT password 'secret'."""
    from server.credential_verifier import StaticCredentialVerifier

    mock_settings = MagicMock()
    mock_settings.hashed_api_keys = {}
    mock_settings.mqtt_password = "secret"
    mock_settings.parsed_cert_labels = {}
    return StaticCredentialVerifier(mock_settings)


@pytest.fixture()
def empty_verifier():
    """StaticCredentialVerifier with no credentials configured."""
    from server.credential_verifier import StaticCredentialVerifier

    mock_settings = MagicMock()
    mock_settings.hashed_api_keys = {}
    mock_settings.mqtt_password = ""
    mock_settings.parsed_cert_labels = {}
    return StaticCredentialVerifier(mock_settings)


def _ctx(settings, write_api, verifier, limiter=None) -> BrokerContext:
    return BrokerContext(
        settings=settings,
        write_api=write_api,
        verifier=verifier,
        limiter=limiter or _limiter(),
    )


@pytest.fixture()
def broker_ctx(settings, mock_write_api, static_verifier, monkeypatch):
    """Install a BrokerContext for the plugin under test; restored afterwards."""
    ctx = _ctx(settings, mock_write_api, static_verifier)
    monkeypatch.setattr(mqtt_module, "_broker_ctx", ctx)
    return ctx


def _make_message(data: bytes | str, topic: str = "mallard/metrics") -> MagicMock:
    msg = MagicMock()
    msg.data = data if isinstance(data, bytes) else data.encode()
    msg.topic = topic
    return msg


VALID_JSON = json.dumps({
    "schema_version": 1,
    "instance_id": "abc123",
    "sent_at": 1_700_000_000_500,
    "tz_offset_minutes": 120,
    "events": [
        {
            "id": "local:f1:span-1",
            "ts": 1_700_000_000_000,
            "connector": "local",
            "model": "claude-sonnet-4-5",
            "surface": "agent",
            "credits": 5.0,
            "cost_usd": 0.2,
            "estimated": True,
            "language": "typescript",
        }
    ],
})


class TestMqttHandleMessage:
    async def test_valid_payload_calls_write(self, mock_write_api, settings, static_verifier) -> None:
        from server.mqtt import _handle_message

        await _handle_message(_make_message(VALID_JSON), "c1", _ctx(settings, mock_write_api, static_verifier))
        mock_write_api.write.assert_called_once()

    async def test_valid_payload_with_source(self, mock_write_api, settings, static_verifier) -> None:
        from server.mqtt import _handle_message

        await _handle_message(
            _make_message(VALID_JSON), "c1", _ctx(settings, mock_write_api, static_verifier), source="team-alpha"
        )
        mock_write_api.write.assert_called_once()

    async def test_invalid_json_does_not_crash(self, mock_write_api, settings, static_verifier) -> None:
        from server.mqtt import _handle_message

        await _handle_message(_make_message(b"not { valid json"), "c1", _ctx(settings, mock_write_api, static_verifier))
        mock_write_api.write.assert_not_called()

    async def test_schema_mismatch_does_not_crash(self, mock_write_api, settings, static_verifier) -> None:
        from server.mqtt import _handle_message

        bad = json.dumps({"completely": "wrong", "shape": True})
        await _handle_message(_make_message(bad), "c1", _ctx(settings, mock_write_api, static_verifier))
        mock_write_api.write.assert_not_called()

    async def test_write_failure_does_not_crash(self, mock_write_api, settings, static_verifier) -> None:
        from server.mqtt import _handle_message

        mock_write_api.write = AsyncMock(side_effect=RuntimeError("influxdb down"))
        await _handle_message(_make_message(VALID_JSON), "c1", _ctx(settings, mock_write_api, static_verifier))

    async def test_out_of_scope_topic_is_dropped(self, mock_write_api, settings, static_verifier) -> None:
        from server.mqtt import _handle_message

        msg = _make_message(VALID_JSON, topic="somethingelse/x")
        await _handle_message(msg, "c1", _ctx(settings, mock_write_api, static_verifier))
        mock_write_api.write.assert_not_called()

    async def test_oversized_message_is_dropped(self, mock_write_api, settings, static_verifier) -> None:
        from server.mqtt import _handle_message

        huge = b"x" * (64 * 1024 + 1)
        await _handle_message(_make_message(huge), "c1", _ctx(settings, mock_write_api, static_verifier))
        mock_write_api.write.assert_not_called()

    async def test_rate_limit_drops_excess_messages(self, mock_write_api, settings, static_verifier) -> None:
        from server.mqtt import _handle_message

        ctx = _ctx(settings, mock_write_api, static_verifier, limiter=_limiter("1/minute"))
        await _handle_message(_make_message(VALID_JSON), "c1", ctx)
        await _handle_message(_make_message(VALID_JSON), "c1", ctx)  # second exceeds 1/min for c1
        assert mock_write_api.write.call_count == 1

    async def test_rate_limit_is_per_peer_address(self, mock_write_api, settings, static_verifier) -> None:
        # Previously keyed on the client-chosen client_id (so "c1" vs "c2" were
        # separate buckets); the bucket is now the peer address.
        from server.mqtt import _handle_message

        ctx = _ctx(settings, mock_write_api, static_verifier, limiter=_limiter("1/minute"))
        await _handle_message(_make_message(VALID_JSON), "c1", ctx, remote_address="10.0.0.1")
        await _handle_message(_make_message(VALID_JSON), "c1", ctx, remote_address="10.0.0.2")
        assert mock_write_api.write.call_count == 2  # different peer, still allowed
        await _handle_message(_make_message(VALID_JSON), "c1", ctx, remote_address="10.0.0.1")
        assert mock_write_api.write.call_count == 2  # same peer, over its limit

    async def test_varying_client_id_does_not_dodge_the_limit(
        self, mock_write_api, settings, static_verifier
    ) -> None:
        """client_id is chosen by the (password-holding) client: minting a new one
        per message must neither reset the limit nor grow the limiter map."""
        from server.mqtt import _handle_message

        limiter = _limiter("2/minute")
        ctx = _ctx(settings, mock_write_api, static_verifier, limiter=limiter)
        for i in range(10):
            await _handle_message(_make_message(VALID_JSON), f"fresh-id-{i}", ctx, remote_address="10.0.0.1")
        assert mock_write_api.write.call_count == 2
        assert len(limiter._hits) == 1
        assert not any("fresh-id" in key for key in limiter._hits)

    async def test_without_a_peer_address_all_clients_share_the_source_bucket(
        self, mock_write_api, settings, static_verifier
    ) -> None:
        from server.mqtt import _handle_message

        ctx = _ctx(settings, mock_write_api, static_verifier, limiter=_limiter("1/minute"))
        await _handle_message(_make_message(VALID_JSON), "c1", ctx)
        await _handle_message(_make_message(VALID_JSON), "c2", ctx)
        assert mock_write_api.write.call_count == 1


class TestMallardAuthPlugin:
    """Test the amqtt auth plugin directly by instantiating it with a minimal context."""

    def _make_plugin(self):
        from server.mqtt import _MallardAuthPlugin

        ctx = MagicMock()
        ctx.config = _MallardAuthPlugin.Config()
        ctx.logger = logging.getLogger("test.auth")
        return _MallardAuthPlugin(ctx)

    async def test_rejects_missing_password(self, broker_ctx) -> None:
        plugin = self._make_plugin()
        session = MagicMock()
        session.password = None

        assert await plugin.authenticate(session=session) is False

    async def test_rejects_empty_password(self, broker_ctx) -> None:
        plugin = self._make_plugin()
        session = MagicMock()
        session.password = ""

        assert await plugin.authenticate(session=session) is False

    async def test_rejects_wrong_password(self, broker_ctx) -> None:
        plugin = self._make_plugin()
        session = MagicMock()
        session.password = "wrong-password"

        assert await plugin.authenticate(session=session) is False

    async def test_accepts_shared_password(self, broker_ctx) -> None:
        plugin = self._make_plugin()
        session = MagicMock()
        session.password = "secret"
        session.client_id = "client-1"

        assert await plugin.authenticate(session=session) is True

    async def test_rejects_when_no_password_configured(
        self, settings, mock_write_api, empty_verifier, monkeypatch
    ) -> None:
        ctx = _ctx(settings, mock_write_api, empty_verifier)
        monkeypatch.setattr(mqtt_module, "_broker_ctx", ctx)
        plugin = self._make_plugin()
        session = MagicMock()
        session.password = "any-password"

        assert await plugin.authenticate(session=session) is False

    async def test_rejects_without_broker_context(self, monkeypatch) -> None:
        monkeypatch.setattr(mqtt_module, "_broker_ctx", None)
        plugin = self._make_plugin()
        session = MagicMock()
        session.password = "secret"

        assert await plugin.authenticate(session=session) is False

    async def test_rejects_when_verifier_raises(
        self, settings, mock_write_api, monkeypatch
    ) -> None:
        raising_verifier = MagicMock()
        raising_verifier.verify_mqtt_password = AsyncMock(side_effect=RuntimeError("vault down"))
        ctx = _ctx(settings, mock_write_api, raising_verifier)
        monkeypatch.setattr(mqtt_module, "_broker_ctx", ctx)
        plugin = self._make_plugin()
        session = MagicMock()
        session.password = "secret"

        assert await plugin.authenticate(session=session) is False


class TestMallardMessagePlugin:
    """Test the amqtt message plugin directly."""

    def _make_plugin(self):
        from server.mqtt import _MallardMessagePlugin

        ctx = MagicMock()
        ctx.config = _MallardMessagePlugin.Config()
        ctx.logger = logging.getLogger("test.msg")
        return _MallardMessagePlugin(ctx)

    async def test_valid_message_calls_write(self, broker_ctx, mock_write_api) -> None:
        plugin = self._make_plugin()

        await plugin.on_broker_message_received(
            client_id="test-client", message=_make_message(VALID_JSON)
        )
        mock_write_api.write.assert_called_once()

    async def test_all_messages_tagged_source_mqtt(self, broker_ctx, mock_write_api) -> None:
        plugin = self._make_plugin()

        with patch("server.mqtt.write_payload", new=AsyncMock()) as write_mock:
            await plugin.on_broker_message_received(
                client_id="whoever", message=_make_message(VALID_JSON)
            )
        assert write_mock.call_args.kwargs["source"] == MQTT_SOURCE

    async def test_none_message_does_not_crash(self, broker_ctx, mock_write_api) -> None:
        plugin = self._make_plugin()

        await plugin.on_broker_message_received(client_id="test-client", message=None)
        mock_write_api.write.assert_not_called()

    async def test_invalid_json_does_not_crash(self, broker_ctx, mock_write_api) -> None:
        plugin = self._make_plugin()

        await plugin.on_broker_message_received(
            client_id="test-client", message=_make_message(b"not json {{")
        )
        mock_write_api.write.assert_not_called()

    async def test_message_without_broker_context_does_not_crash(
        self, mock_write_api, monkeypatch
    ) -> None:
        monkeypatch.setattr(mqtt_module, "_broker_ctx", None)
        plugin = self._make_plugin()

        await plugin.on_broker_message_received(
            client_id="test-client", message=_make_message(VALID_JSON)
        )
        mock_write_api.write.assert_not_called()


class TestMallardTopicPlugin:
    """Broker-level ACL: publish / subscribe / delivery only under MQTT_TOPIC_PREFIX."""

    def _make_plugin(self):
        from server.mqtt import _MallardTopicPlugin

        ctx = MagicMock()
        ctx.config = _MallardTopicPlugin.Config()
        ctx.logger = logging.getLogger("test.topic")
        return _MallardTopicPlugin(ctx)

    @pytest.mark.parametrize("action", ["publish", "subscribe", "receive"])
    @pytest.mark.parametrize("topic", ["mallard/metrics", "mallard/a/b", "mallard/#", "mallard/+/x"])
    async def test_in_prefix_topics_allowed(self, broker_ctx, action: str, topic: str) -> None:
        from amqtt.contexts import Action

        assert await self._make_plugin().topic_filtering(topic=topic, action=Action(action)) is True

    @pytest.mark.parametrize("action", ["publish", "subscribe", "receive"])
    @pytest.mark.parametrize("topic", ["other/metrics", "#", "+/x", "mallardx", "", "$SYS/broker/clients"])
    async def test_out_of_prefix_topics_denied(self, broker_ctx, action: str, topic: str) -> None:
        from amqtt.contexts import Action

        assert await self._make_plugin().topic_filtering(topic=topic, action=Action(action)) is False

    async def test_fails_closed_without_broker_context(self, monkeypatch) -> None:
        from amqtt.contexts import Action

        monkeypatch.setattr(mqtt_module, "_broker_ctx", None)
        assert await self._make_plugin().topic_filtering(topic="mallard/x", action=Action.PUBLISH) is False

    async def test_honours_a_custom_prefix(self, broker_ctx, settings) -> None:
        from amqtt.contexts import Action

        settings.mqtt_topic_prefix = "acme/ingest/"
        plugin = self._make_plugin()
        assert await plugin.topic_filtering(topic="acme/ingest/x", action=Action.PUBLISH) is True
        assert await plugin.topic_filtering(topic="mallard/x", action=Action.PUBLISH) is False


class TestMessagePluginPeerAddress:
    async def test_session_remote_address_keys_the_rate_limit(
        self, broker_ctx, mock_write_api
    ) -> None:
        from server.mqtt import _MallardMessagePlugin

        ctx = MagicMock()
        ctx.config = _MallardMessagePlugin.Config()
        ctx.logger = logging.getLogger("test.msg")
        session = MagicMock()
        session.remote_address = "203.0.113.9"
        ctx.get_session.return_value = session
        plugin = _MallardMessagePlugin(ctx)

        with patch("server.mqtt._handle_message", new=AsyncMock()) as handle:
            await plugin.on_broker_message_received(client_id="c1", message=_make_message(VALID_JSON))
        assert handle.call_args.kwargs["remote_address"] == "203.0.113.9"
        ctx.get_session.assert_called_once_with("c1")

    async def test_unknown_session_means_no_address(self, broker_ctx) -> None:
        from server.mqtt import _MallardMessagePlugin

        ctx = MagicMock()
        ctx.config = _MallardMessagePlugin.Config()
        ctx.logger = logging.getLogger("test.msg")
        ctx.get_session.return_value = None
        plugin = _MallardMessagePlugin(ctx)

        with patch("server.mqtt._handle_message", new=AsyncMock()) as handle:
            await plugin.on_broker_message_received(client_id="gone", message=_make_message(VALID_JSON))
        assert handle.call_args.kwargs["remote_address"] is None


class TestMqttBrokerLifecycle:
    """Test run_mqtt_broker starts cleanly and shuts down on cancellation."""

    async def test_starts_and_stops_on_cancel(self, settings, mock_write_api, static_verifier) -> None:
        from server.mqtt import run_mqtt_broker

        mock_broker = AsyncMock()
        mock_broker.start = AsyncMock()
        mock_broker.shutdown = AsyncMock()

        mock_event_instance = MagicMock()
        mock_event_instance.wait = AsyncMock(side_effect=asyncio.CancelledError())

        with (
            patch("server.mqtt.Broker", return_value=mock_broker),
            patch("server.mqtt.asyncio.Event", return_value=mock_event_instance),
        ):
            await run_mqtt_broker(settings, mock_write_api, static_verifier)

        mock_broker.start.assert_called_once()
        mock_broker.shutdown.assert_called_once()
        assert mqtt_module._broker_ctx is None  # cleared on shutdown

    async def test_registers_topic_acl_and_prunes_the_limiter(
        self, settings, mock_write_api, static_verifier
    ) -> None:
        from server.mqtt import run_mqtt_broker

        mock_broker = AsyncMock()
        mock_event_instance = MagicMock()
        mock_event_instance.wait = AsyncMock(side_effect=asyncio.CancelledError())
        pruned = []

        def fake_prune(limiter, interval: float = 300.0):
            pruned.append(limiter)  # recorded when the task is created: the mocked
            return asyncio.sleep(3600)  # broker stops before the task is ever scheduled

        with (
            patch("server.mqtt.Broker", return_value=mock_broker) as broker_cls,
            patch("server.mqtt.asyncio.Event", return_value=mock_event_instance),
            patch("server.mqtt.prune_expired", fake_prune),
        ):
            await run_mqtt_broker(settings, mock_write_api, static_verifier)

        plugins = broker_cls.call_args.kwargs["config"]["plugins"]
        assert any(name.endswith("._MallardTopicPlugin") for name in plugins)
        assert len(pruned) == 1 and isinstance(pruned[0], SlidingWindowLimiter)


class TestRealBrokerEnforcesTopicAcl:
    """End to end through the real amqtt broker (WebSocket, auth plugin, topic
    plugin, message plugin) rather than the plugins in isolation."""

    async def test_out_of_prefix_subscribe_denied_and_publish_not_relayed(
        self, settings, mock_write_api, static_verifier
    ) -> None:
        import socket

        from amqtt.client import MQTTClient

        from server.mqtt import run_mqtt_broker

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            settings.mqtt_port = s.getsockname()[1]
        broker = asyncio.create_task(run_mqtt_broker(settings, mock_write_api, static_verifier))
        url = f"ws://u:secret@127.0.0.1:{settings.mqtt_port}"
        clients = []
        try:
            subscriber = MQTTClient(client_id="sub", config={"auto_reconnect": False})
            for _ in range(50):  # wait for the listener
                try:
                    await subscriber.connect(url)
                    break
                except Exception:
                    await asyncio.sleep(0.1)
            else:
                pytest.fail("broker never started listening")
            clients.append(subscriber)

            codes = await subscriber.subscribe([("mallard/#", 0), ("other/#", 0), ("#", 0)])
            assert codes == [0, 0x80, 0x80]

            publisher = MQTTClient(client_id="pub", config={"auto_reconnect": False})
            await publisher.connect(url)
            clients.append(publisher)
            await publisher.publish("other/secret", b"leak")
            await publisher.publish("mallard/metrics", b"ok")

            delivered = await asyncio.wait_for(subscriber.deliver_message(), timeout=5)
            assert delivered.publish_packet.variable_header.topic_name == "mallard/metrics"
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(subscriber.deliver_message(), timeout=0.5)
        finally:
            for c in clients:
                try:
                    await c.disconnect()
                except Exception:  # best-effort teardown
                    pass
            broker.cancel()
            await asyncio.gather(broker, return_exceptions=True)
