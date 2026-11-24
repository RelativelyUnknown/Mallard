"""Tests for main.py — rate-limit key function and MQTT lifespan branch."""

from __future__ import annotations

import asyncio
import importlib
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

_ENV = {
    "INFLUX_URL": "http://influxdb-test:8086",
    "INFLUX_TOKEN": "testtoken",
    "INFLUX_ORG": "mallard",
    "INFLUX_BUCKET": "metrics",
    "API_KEYS": "test-key-valid",
    "LOG_LEVEL": "DEBUG",
    "RATE_LIMIT": "1000/minute",
}


class TestRateLimitKeyFunction:
    def test_ignores_api_key_header(self) -> None:
        """Keying on a client-supplied header let attackers mint a fresh bucket
        per junk key — the pre-auth limiter must key on the client IP only."""
        from server.main import _get_key_for_rate_limit

        req = MagicMock()
        req.headers = {"X-API-Key": "abc123"}
        req.client.host = "10.0.0.1"
        assert _get_key_for_rate_limit(req) == "10.0.0.1"

    def test_uses_client_ip(self) -> None:
        from server.main import _get_key_for_rate_limit

        req = MagicMock()
        req.client.host = "10.0.0.1"
        assert _get_key_for_rate_limit(req) == "10.0.0.1"

    def test_unknown_when_no_client(self) -> None:
        from server.main import _get_key_for_rate_limit

        req = MagicMock()
        req.client = None
        assert _get_key_for_rate_limit(req) == "unknown"


class TestMqttLifespan:
    def test_mqtt_task_created_when_enabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        for k, v in _ENV.items():
            monkeypatch.setenv(k, v)
        monkeypatch.setenv("MQTT_ENABLED", "true")
        monkeypatch.setenv("MQTT_PASSWORD", "test-mqtt-password")

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)

        mock_influx = MagicMock()
        mock_influx.write_api.return_value = MagicMock()
        mock_influx.ping = AsyncMock(return_value=True)
        mock_influx.close = AsyncMock()

        async def _noop_mqtt(settings, write_api, verifier) -> None:
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                return

        with (
            patch("server.influx.make_client", return_value=mock_influx),
            patch("server.mqtt.run_mqtt_broker", _noop_mqtt),
        ):
            import server.main as main_module

            importlib.reload(main_module)
            app = main_module.create_app()

            with TestClient(app, raise_server_exceptions=False):
                assert hasattr(app.state, "mqtt_task")
                assert not app.state.mqtt_task.done()


class TestHealthExemptFromIpLimiter:
    """Readiness probes hit /health on a fixed cadence from a few IPs; counting
    them against the pre-auth limiter would 429 the probe and drain the pod."""

    def test_health_is_not_counted_but_other_routes_are(
        self, monkeypatch: pytest.MonkeyPatch, mock_influx_client: MagicMock
    ) -> None:
        from .conftest import _build_client

        for tc in _build_client(monkeypatch, mock_influx_client, {"RATE_LIMIT": "2/minute"}):
            assert [tc.get("/health").status_code for _ in range(6)] == [200] * 6
            # The limiter is genuinely active: the third unauthenticated ingest
            # from the same IP is cut off by the pre-auth limiter, not by auth.
            codes = [tc.post("/api/v1/ingest", json={}).status_code for _ in range(3)]
            assert codes == [401, 401, 429]


class TestMqttTaskFailureIsLogged:
    async def test_crash_is_logged_with_traceback(self, caplog: pytest.LogCaptureFixture) -> None:
        from server.main import _log_mqtt_task_exit

        async def _boom() -> None:
            raise OSError("address already in use")

        task = asyncio.create_task(_boom())
        task.add_done_callback(_log_mqtt_task_exit)
        with caplog.at_level("ERROR", logger="server.main"):
            await asyncio.wait([task])
            await asyncio.sleep(0)  # let the done-callback run
        record = next(r for r in caplog.records if "MQTT broker task exited" in r.getMessage())
        assert "address already in use" in record.getMessage()
        assert record.exc_info is not None

    async def test_cancellation_is_not_an_error(self, caplog: pytest.LogCaptureFixture) -> None:
        from server.main import _log_mqtt_task_exit

        task = asyncio.create_task(asyncio.sleep(3600))
        task.add_done_callback(_log_mqtt_task_exit)
        with caplog.at_level("ERROR", logger="server.main"):
            task.cancel()
            await asyncio.wait([task])
            await asyncio.sleep(0)
        assert not [r for r in caplog.records if "MQTT broker task" in r.getMessage()]

    def test_lifespan_attaches_the_callback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for k, v in _ENV.items():
            monkeypatch.setenv(k, v)
        monkeypatch.setenv("MQTT_ENABLED", "true")
        monkeypatch.setenv("MQTT_PASSWORD", "test-mqtt-password")

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        mock_influx = MagicMock()
        mock_influx.write_api.return_value = MagicMock()
        mock_influx.ping = AsyncMock(return_value=True)
        mock_influx.close = AsyncMock()

        async def _crashing_mqtt(settings, write_api, verifier) -> None:
            raise OSError("port in use")

        with (
            patch("server.influx.make_client", return_value=mock_influx),
            patch("server.mqtt.run_mqtt_broker", _crashing_mqtt),
            patch("server.main.logger") as log,
        ):
            import server.main as main_module

            importlib.reload(main_module)
            with patch.object(main_module, "logger", log):
                app = main_module.create_app()
                with TestClient(app, raise_server_exceptions=False):
                    import time

                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline and not log.error.called:
                        time.sleep(0.01)
        assert any("MQTT broker task exited" in str(c.args[0]) for c in log.error.call_args_list)
