"""100% coverage tests for src.credential_verifier."""

from __future__ import annotations

import asyncio
import hashlib
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── CredentialStore.parse_labeled ─────────────────────────────────────────────


class TestCredentialStoreParseLabled:
    def test_labeled_entry(self) -> None:
        from server.credential_verifier import CredentialStore

        result = CredentialStore.parse_labeled("team-alpha:mykey")
        h = hashlib.sha256(b"mykey").hexdigest()
        assert result == {h: "team-alpha"}

    def test_bare_entry_gets_unknown_label(self) -> None:
        from server.credential_verifier import CredentialStore

        result = CredentialStore.parse_labeled("bare-key")
        h = hashlib.sha256(b"bare-key").hexdigest()
        assert result == {h: "unknown"}

    def test_empty_string_returns_empty_dict(self) -> None:
        from server.credential_verifier import CredentialStore

        assert CredentialStore.parse_labeled("") == {}

    def test_whitespace_only_entries_skipped(self) -> None:
        from server.credential_verifier import CredentialStore

        assert CredentialStore.parse_labeled("  ,  ,  ") == {}

    def test_multiple_entries_parsed(self) -> None:
        from server.credential_verifier import CredentialStore

        result = CredentialStore.parse_labeled("alice:pass1,bob:pass2")
        h1 = hashlib.sha256(b"pass1").hexdigest()
        h2 = hashlib.sha256(b"pass2").hexdigest()
        assert result[h1] == "alice"
        assert result[h2] == "bob"

    def test_label_whitespace_stripped(self) -> None:
        from server.credential_verifier import CredentialStore

        result = CredentialStore.parse_labeled("  team-x  :secret")
        h = hashlib.sha256(b"secret").hexdigest()
        assert result[h] == "team-x"

    def test_mixed_bare_and_labeled(self) -> None:
        from server.credential_verifier import CredentialStore

        result = CredentialStore.parse_labeled("bare,labeled:key")
        h_bare = hashlib.sha256(b"bare").hexdigest()
        h_labeled = hashlib.sha256(b"key").hexdigest()
        assert result[h_bare] == "unknown"
        assert result[h_labeled] == "labeled"

    def test_invalid_label_characters_replaced_with_unknown(self) -> None:
        from server.credential_verifier import CredentialStore

        result = CredentialStore.parse_labeled("label with spaces:mykey")
        h = hashlib.sha256(b"mykey").hexdigest()
        assert result[h] == "unknown"

    def test_label_exceeding_64_chars_replaced_with_unknown(self) -> None:
        from server.credential_verifier import CredentialStore

        long_label = "a" * 65
        result = CredentialStore.parse_labeled(f"{long_label}:mykey")
        h = hashlib.sha256(b"mykey").hexdigest()
        assert result[h] == "unknown"

    def test_label_exactly_64_chars_is_valid(self) -> None:
        from server.credential_verifier import CredentialStore

        label = "a" * 64
        result = CredentialStore.parse_labeled(f"{label}:mykey")
        h = hashlib.sha256(b"mykey").hexdigest()
        assert result[h] == label


# ── CredentialStore.parse_cert_labels ─────────────────────────────────────────


class TestParseCertLabels:
    def test_valid_entries(self) -> None:
        from server.credential_verifier import CredentialStore

        result = CredentialStore.parse_cert_labels("team-a:machine-01,ci:runner_2")
        assert result == {"machine-01": "team-a", "runner_2": "ci"}

    def test_empty_string(self) -> None:
        from server.credential_verifier import CredentialStore

        assert CredentialStore.parse_cert_labels("") == {}

    def test_bare_entry_skipped(self) -> None:
        from server.credential_verifier import CredentialStore

        # A CN without a label is meaningless here — the unmapped-CN fallback
        # (source = CN itself) already covers it.
        assert CredentialStore.parse_cert_labels("just-a-cn") == {}

    def test_invalid_label_skipped(self) -> None:
        from server.credential_verifier import CredentialStore

        assert CredentialStore.parse_cert_labels("bad label!:machine-01") == {}

    def test_invalid_cn_skipped(self) -> None:
        from server.credential_verifier import CredentialStore

        assert CredentialStore.parse_cert_labels("team:cn with spaces") == {}

    def test_mixed_valid_and_invalid(self) -> None:
        from server.credential_verifier import CredentialStore

        result = CredentialStore.parse_cert_labels("team:good-cn,broken entry,ci:runner")
        assert result == {"good-cn": "team", "runner": "ci"}


# ── StaticCredentialVerifier ──────────────────────────────────────────────────


class TestStaticCredentialVerifier:
    def _make_settings(
        self,
        api_keys: dict[str, str],
        mqtt_password: str = "",
        cert_labels: dict[str, str] | None = None,
    ) -> MagicMock:
        s = MagicMock()
        s.hashed_api_keys = api_keys
        s.mqtt_password = mqtt_password
        s.parsed_cert_labels = cert_labels or {}
        return s

    async def test_verify_api_key_valid(self) -> None:
        from server.credential_verifier import StaticCredentialVerifier, VerifiedIdentity

        h = hashlib.sha256(b"good-key").hexdigest()
        verifier = StaticCredentialVerifier(self._make_settings({h: "my-label"}))
        result = await verifier.verify_api_key("good-key")
        assert result == VerifiedIdentity(label="my-label")

    async def test_verify_api_key_invalid(self) -> None:
        from server.credential_verifier import StaticCredentialVerifier

        h = hashlib.sha256(b"good-key").hexdigest()
        verifier = StaticCredentialVerifier(self._make_settings({h: "label"}))
        result = await verifier.verify_api_key("wrong-key")
        assert result is None

    async def test_verify_api_key_empty_store(self) -> None:
        from server.credential_verifier import StaticCredentialVerifier

        verifier = StaticCredentialVerifier(self._make_settings({}))
        assert await verifier.verify_api_key("any") is None

    async def test_verify_mqtt_password_valid(self) -> None:
        from server.credential_verifier import StaticCredentialVerifier

        verifier = StaticCredentialVerifier(self._make_settings({}, mqtt_password="mqtt-pass"))
        assert await verifier.verify_mqtt_password("mqtt-pass") is True

    async def test_verify_mqtt_password_invalid(self) -> None:
        from server.credential_verifier import StaticCredentialVerifier

        verifier = StaticCredentialVerifier(self._make_settings({}, mqtt_password="mqtt-pass"))
        assert await verifier.verify_mqtt_password("wrong-pass") is False

    async def test_verify_mqtt_password_none_configured(self) -> None:
        from server.credential_verifier import StaticCredentialVerifier

        verifier = StaticCredentialVerifier(self._make_settings({}))
        assert await verifier.verify_mqtt_password("any") is False

    async def test_lookup_cert_label_hit(self) -> None:
        from server.credential_verifier import StaticCredentialVerifier

        verifier = StaticCredentialVerifier(
            self._make_settings({}, cert_labels={"machine-01": "team-alpha"})
        )
        assert await verifier.lookup_cert_label("machine-01") == "team-alpha"

    async def test_lookup_cert_label_miss_returns_none(self) -> None:
        from server.credential_verifier import StaticCredentialVerifier

        verifier = StaticCredentialVerifier(self._make_settings({}))
        assert await verifier.lookup_cert_label("unmapped-cn") is None


# ── RemoteCredentialVerifier caching (via OpenBaoCredentialVerifier) ─────────


class TestRemoteCredentialVerifierCaching:
    def _make_remote_verifier(self, ttl: int = 30):
        from server.credential_verifier import OpenBaoCredentialVerifier

        s = MagicMock()
        s.secret_manager_url = "http://openbao:8200"
        s.secret_manager_token = "tok"
        s.secret_manager_ca_cert_path = ""
        s.openbao_secret_path = "secret/data/mallard/server"
        s.openbao_namespace = ""
        v = OpenBaoCredentialVerifier(s, ttl_seconds=ttl)
        return v

    def _mock_store(self, api_key: str = "key", label: str = "lbl"):
        from server.credential_verifier import CredentialStore

        h = hashlib.sha256(api_key.encode()).hexdigest()
        return CredentialStore(api_keys={h: label})

    async def test_fetch_store_called_on_first_access(self) -> None:
        verifier = self._make_remote_verifier()
        store = self._mock_store()

        with patch.object(verifier, "_fetch_store", new=AsyncMock(return_value=store)) as mock_fetch:
            await verifier._get_store()
            mock_fetch.assert_called_once()

    async def test_cache_used_within_ttl(self) -> None:
        verifier = self._make_remote_verifier(ttl=60)
        store = self._mock_store()

        with patch.object(verifier, "_fetch_store", new=AsyncMock(return_value=store)) as mock_fetch:
            await verifier._get_store()
            await verifier._get_store()
            mock_fetch.assert_called_once()  # only fetched once

    async def test_refetch_after_ttl_expires(self) -> None:
        verifier = self._make_remote_verifier(ttl=0)  # TTL = 0 always expires
        store = self._mock_store()

        with patch.object(verifier, "_fetch_store", new=AsyncMock(return_value=store)) as mock_fetch:
            await verifier._get_store()
            # Force TTL expiry by resetting fetched_at to distant past
            from server.credential_verifier import CredentialStore

            old_store = CredentialStore(fetched_at=time.monotonic() - 100)
            verifier._store = old_store
            await verifier._get_store()
            assert mock_fetch.call_count == 2

    async def test_concurrent_calls_fetch_once(self) -> None:
        """Lock prevents thundering herd — only one fetch even under concurrency."""
        verifier = self._make_remote_verifier(ttl=60)
        store = self._mock_store()

        fetch_count = 0

        async def slow_fetch():
            nonlocal fetch_count
            fetch_count += 1
            await asyncio.sleep(0.05)
            return store

        with patch.object(verifier, "_fetch_store", new=slow_fetch):
            await asyncio.gather(*[verifier._get_store() for _ in range(5)])

        assert fetch_count == 1

    async def test_verify_api_key_via_cached_store(self) -> None:
        from server.credential_verifier import VerifiedIdentity

        verifier = self._make_remote_verifier()
        store = self._mock_store(api_key="my-key", label="my-team")

        with patch.object(verifier, "_fetch_store", new=AsyncMock(return_value=store)):
            result = await verifier.verify_api_key("my-key")
        assert result == VerifiedIdentity(label="my-team")

    async def test_verify_mqtt_via_cached_store(self) -> None:
        from server.credential_verifier import CredentialStore

        verifier = self._make_remote_verifier()
        h = hashlib.sha256(b"mqtt-pass").hexdigest()
        store = CredentialStore(api_keys={}, mqtt_password_hash=h)

        with patch.object(verifier, "_fetch_store", new=AsyncMock(return_value=store)):
            assert await verifier.verify_mqtt_password("mqtt-pass") is True
            assert await verifier.verify_mqtt_password("wrong") is False

    async def test_lookup_cert_label_via_cached_store(self) -> None:
        from server.credential_verifier import CredentialStore

        verifier = self._make_remote_verifier()
        store = CredentialStore(cert_labels={"build-agent": "ci"})

        with patch.object(verifier, "_fetch_store", new=AsyncMock(return_value=store)):
            assert await verifier.lookup_cert_label("build-agent") == "ci"
            assert await verifier.lookup_cert_label("other") is None

    async def test_first_fetch_failure_propagates_to_caller(self) -> None:
        """No cache yet → exception from _fetch_store propagates."""
        verifier = self._make_remote_verifier()

        with patch.object(
            verifier, "_fetch_store", new=AsyncMock(side_effect=RuntimeError("openbao down"))
        ):
            with pytest.raises(RuntimeError, match="openbao down"):
                await verifier._get_store()

    async def test_first_fetch_failure_verify_api_key_raises(self) -> None:
        """No cache yet → verify_api_key raises rather than returning None."""
        verifier = self._make_remote_verifier()

        with patch.object(
            verifier, "_fetch_store", new=AsyncMock(side_effect=RuntimeError("network error"))
        ):
            with pytest.raises(RuntimeError):
                await verifier.verify_api_key("any-key")

    async def test_subsequent_fetch_failure_returns_stale_cache(self) -> None:
        """After a successful fetch, a later failure keeps serving the old store."""
        verifier = self._make_remote_verifier(ttl=0)
        initial_store = self._mock_store(api_key="valid-key", label="team-a")

        with patch.object(verifier, "_fetch_store", new=AsyncMock(return_value=initial_store)):
            await verifier._get_store()

        # Force TTL expiry by backdating fetched_at
        from server.credential_verifier import CredentialStore

        verifier._store = CredentialStore(
            api_keys=initial_store.api_keys,
            fetched_at=time.monotonic() - 100,
        )

        with patch.object(
            verifier, "_fetch_store", new=AsyncMock(side_effect=RuntimeError("still down"))
        ):
            result = await verifier._get_store()

        # Stale store is returned — caller is not interrupted
        assert result is not None
        assert result.api_keys == initial_store.api_keys

    async def test_subsequent_fetch_failure_verify_still_works(self) -> None:
        """verify_api_key succeeds against stale cache when refresh fails."""
        from server.credential_verifier import CredentialStore, VerifiedIdentity

        verifier = self._make_remote_verifier(ttl=0)
        initial_store = self._mock_store(api_key="good-key", label="my-team")

        with patch.object(verifier, "_fetch_store", new=AsyncMock(return_value=initial_store)):
            await verifier._get_store()

        verifier._store = CredentialStore(
            api_keys=initial_store.api_keys,
            fetched_at=time.monotonic() - 100,
        )

        with patch.object(
            verifier, "_fetch_store", new=AsyncMock(side_effect=RuntimeError("transient"))
        ):
            result = await verifier.verify_api_key("good-key")

        assert result == VerifiedIdentity(label="my-team")


# ── RemoteCredentialVerifier: single-flight, backoff, max-stale ───────────────


class _FakeClock:
    """Stands in for the `time` module inside server.credential_verifier only
    (patching time.monotonic globally would also move the event loop's clock)."""

    def __init__(self, now: float = 10_000.0) -> None:
        self.now = now

    def monotonic(self) -> float:
        return self.now


class TestRemoteVerifierResilience:
    def _verifier(self, **kwargs):
        from server.credential_verifier import OpenBaoCredentialVerifier

        s = MagicMock()
        s.secret_manager_url = "http://openbao:8200"
        s.secret_manager_token = "tok"
        s.secret_manager_ca_cert_path = ""
        s.openbao_secret_path = "secret/data/mallard/server"
        s.openbao_namespace = ""
        return OpenBaoCredentialVerifier(s, **kwargs)

    @staticmethod
    def _aged_store(age: float, api_key: str = "key", label: str = "lbl", now: float | None = None):
        from server.credential_verifier import CredentialStore

        t = time.monotonic() if now is None else now
        h = hashlib.sha256(api_key.encode()).hexdigest()
        return CredentialStore(api_keys={h: label}, fetched_at=t - age)

    async def test_failed_refresh_is_not_retried_by_every_request(self) -> None:
        """A failed refresh used to leave fetched_at untouched, so every single
        request re-ran the (up to 10s) fetch."""
        verifier = self._verifier()
        stale = self._aged_store(100)
        verifier._store = stale
        fetch = AsyncMock(side_effect=RuntimeError("openbao down"))

        with patch.object(verifier, "_fetch_store", new=fetch):
            results = [await verifier._get_store() for _ in range(5)]

        assert fetch.call_count == 1
        assert all(r is stale for r in results)

    async def test_concurrent_failing_refreshes_share_one_fetch(self) -> None:
        """The fetch used to run under the lock, so N waiters meant N serial failures."""
        verifier = self._verifier()
        verifier._store = self._aged_store(100)
        calls = 0

        async def slow_failure():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.05)
            raise RuntimeError("openbao down")

        with patch.object(verifier, "_fetch_store", new=slow_failure):
            await asyncio.gather(*[verifier._get_store() for _ in range(5)])

        assert calls == 1

    async def test_requests_are_not_blocked_behind_a_slow_refresh(self) -> None:
        """The lock used to be held across the HTTP fetch, stalling every request
        (even though a usable cached store existed) for as long as it took."""
        verifier = self._verifier()
        stale = self._aged_store(100)
        verifier._store = stale
        release = asyncio.Event()
        fresh = self._aged_store(0)

        async def blocked_fetch():
            await release.wait()
            return fresh

        with patch.object(verifier, "_fetch_store", new=blocked_fetch):
            refresher = asyncio.ensure_future(verifier._get_store())
            await asyncio.sleep(0)  # let the refresh start
            assert await asyncio.wait_for(verifier._get_store(), timeout=1.0) is stale
            release.set()
            assert await refresher is fresh

    async def test_first_fetch_failure_backs_off_instead_of_hammering(self) -> None:
        from server.credential_verifier import CredentialStoreUnavailable

        verifier = self._verifier()
        fetch = AsyncMock(side_effect=RuntimeError("openbao down"))

        with patch.object(verifier, "_fetch_store", new=fetch):
            with pytest.raises(RuntimeError, match="openbao down"):
                await verifier._get_store()
            for _ in range(3):
                with pytest.raises(CredentialStoreUnavailable):
                    await verifier._get_store()

        assert fetch.call_count == 1

    async def test_backoff_is_exponential_and_capped(self, monkeypatch) -> None:
        import server.credential_verifier as cv

        clock = _FakeClock()
        monkeypatch.setattr(cv, "time", clock)
        verifier = self._verifier()
        verifier._store = self._aged_store(100, now=clock.now)
        fetch = AsyncMock(side_effect=RuntimeError("down"))

        with patch.object(verifier, "_fetch_store", new=fetch):
            await verifier._get_store()  # failure 1 -> back off 1s
            assert fetch.call_count == 1
            clock.now += 0.5
            await verifier._get_store()
            assert fetch.call_count == 1  # still backing off
            clock.now += 0.6
            await verifier._get_store()  # failure 2 -> back off 2s
            assert fetch.call_count == 2
            clock.now += 1.5
            await verifier._get_store()
            assert fetch.call_count == 2  # 1s would have elapsed, 2s has not
            clock.now += 0.6
            await verifier._get_store()
            assert fetch.call_count == 3
            for _ in range(20):  # many failures: the delay never exceeds the cap
                clock.now += 61.0
                await verifier._get_store()
            assert fetch.call_count == 3 + 20

    async def test_recovery_resets_backoff_and_replaces_the_store(self, monkeypatch) -> None:
        import server.credential_verifier as cv

        clock = _FakeClock()
        monkeypatch.setattr(cv, "time", clock)
        verifier = self._verifier()
        verifier._store = self._aged_store(100, now=clock.now)
        fresh = self._aged_store(0, api_key="new", now=clock.now + 2)
        fetch = AsyncMock(
            side_effect=[RuntimeError("down"), fresh, RuntimeError("down again"), RuntimeError("still down")]
        )

        with patch.object(verifier, "_fetch_store", new=fetch):
            await verifier._get_store()
            clock.now += 2.0
            assert await verifier._get_store() is fresh
            clock.now += 31.0  # fresh store expires; next failure backs off from 1s again
            await verifier._get_store()
            clock.now += 1.1
            await verifier._get_store()
        assert fetch.call_count == 4  # 1s, not the 2s a never-reset counter would give

    async def test_cache_older_than_max_stale_is_refused(self) -> None:
        """Past max-stale a revoked key must stop working: requests get a 503
        (CredentialStoreUnavailable) and health goes unhealthy."""
        from server.credential_verifier import CredentialStoreUnavailable

        verifier = self._verifier(max_stale_seconds=500)
        verifier._store = self._aged_store(1000, api_key="revoked-key")
        fetch = AsyncMock(side_effect=RuntimeError("openbao down"))

        with patch.object(verifier, "_fetch_store", new=fetch):
            with pytest.raises(CredentialStoreUnavailable):
                await verifier.verify_api_key("revoked-key")
            assert await verifier.healthcheck() is False
            with pytest.raises(CredentialStoreUnavailable):
                await verifier.verify_api_key("revoked-key")  # still refused while backing off
        assert fetch.call_count == 1

    async def test_cache_within_max_stale_keeps_serving_and_stays_healthy(self) -> None:
        from server.credential_verifier import VerifiedIdentity

        verifier = self._verifier(max_stale_seconds=500)
        verifier._store = self._aged_store(100, api_key="good-key", label="team")
        fetch = AsyncMock(side_effect=RuntimeError("openbao down"))

        with patch.object(verifier, "_fetch_store", new=fetch):
            assert await verifier.verify_api_key("good-key") == VerifiedIdentity("team")
            assert await verifier.healthcheck() is True

    async def test_default_max_stale_is_24_hours(self) -> None:
        assert self._verifier()._max_stale == 86400

    async def test_cancelled_waiter_does_not_cancel_the_shared_fetch(self) -> None:
        verifier = self._verifier()
        release = asyncio.Event()
        fresh = self._aged_store(0)
        fetch_count = 0

        async def blocked_fetch():
            nonlocal fetch_count
            fetch_count += 1
            await release.wait()
            return fresh

        with patch.object(verifier, "_fetch_store", new=blocked_fetch):
            first = asyncio.ensure_future(verifier._get_store())
            second = asyncio.ensure_future(verifier._get_store())
            await asyncio.sleep(0)
            first.cancel()
            await asyncio.sleep(0)
            release.set()
            assert await second is fresh
        assert fetch_count == 1

    async def test_create_verifier_passes_configured_max_stale(self) -> None:
        from server.credential_verifier import create_verifier

        s = MagicMock()
        s.secret_manager_type = "openbao"
        s.credential_max_stale_seconds = 123.0
        assert create_verifier(s)._max_stale == 123.0


# ── OpenBaoCredentialVerifier._fetch_store ────────────────────────────────────


class TestOpenBaoFetchStore:
    def _make_settings(self, namespace: str = ""):
        s = MagicMock()
        s.secret_manager_url = "http://openbao:8200"
        s.secret_manager_token = "root"
        s.secret_manager_ca_cert_path = ""
        s.openbao_secret_path = "secret/data/mallard/server"
        s.openbao_namespace = namespace
        return s

    def _mock_response(
        self, api_keys: str = "", mqtt_password: str = "", cert_labels: str = ""
    ) -> MagicMock:
        r = MagicMock()
        r.raise_for_status = MagicMock()
        r.json = MagicMock(return_value={
            "data": {"data": {
                "api_keys": api_keys,
                "mqtt_password": mqtt_password,
                "cert_labels": cert_labels,
            }}
        })
        return r

    async def test_success_parses_kv_response(self) -> None:
        from server.credential_verifier import OpenBaoCredentialVerifier

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.get = AsyncMock(
            return_value=self._mock_response("team:k", "broker-pass", "ci:runner")
        )

        with patch("server.credential_verifier.httpx.AsyncClient", return_value=mock_client):
            verifier = OpenBaoCredentialVerifier(self._make_settings())
            store = await verifier._fetch_store()

        hk = hashlib.sha256(b"k").hexdigest()
        assert store.api_keys[hk] == "team"
        assert store.mqtt_password_hash == hashlib.sha256(b"broker-pass").hexdigest()
        assert store.cert_labels == {"runner": "ci"}

    async def test_namespace_header_sent_when_set(self) -> None:
        from server.credential_verifier import OpenBaoCredentialVerifier

        captured_headers: list = []

        class _FakeClient:
            def __init__(self, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def get(self, url, headers=None):
                captured_headers.append(dict(headers or {}))
                r = MagicMock()
                r.raise_for_status = MagicMock()
                r.json = MagicMock(return_value={"data": {"data": {}}})
                return r

        with patch("server.credential_verifier.httpx.AsyncClient", _FakeClient):
            verifier = OpenBaoCredentialVerifier(self._make_settings(namespace="ns1"))
            await verifier._fetch_store()

        assert captured_headers[0].get("X-Vault-Namespace") == "ns1"

    async def test_no_namespace_header_when_empty(self) -> None:
        from server.credential_verifier import OpenBaoCredentialVerifier

        captured_headers: list = []

        class _FakeClient:
            def __init__(self, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def get(self, url, headers=None):
                captured_headers.append(dict(headers or {}))
                r = MagicMock()
                r.raise_for_status = MagicMock()
                r.json = MagicMock(return_value={"data": {"data": {}}})
                return r

        with patch("server.credential_verifier.httpx.AsyncClient", _FakeClient):
            verifier = OpenBaoCredentialVerifier(self._make_settings(namespace=""))
            await verifier._fetch_store()

        assert "X-Vault-Namespace" not in captured_headers[0]

    async def test_http_error_raises(self) -> None:
        from server.credential_verifier import OpenBaoCredentialVerifier

        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock(side_effect=Exception("HTTP 403"))

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.get = AsyncMock(return_value=mock_response)

        with patch("server.credential_verifier.httpx.AsyncClient", return_value=mock_client):
            verifier = OpenBaoCredentialVerifier(self._make_settings())
            with pytest.raises(Exception):
                await verifier._fetch_store()

    async def test_network_error_raises(self) -> None:
        from server.credential_verifier import OpenBaoCredentialVerifier

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))

        with patch("server.credential_verifier.httpx.AsyncClient", return_value=mock_client):
            verifier = OpenBaoCredentialVerifier(self._make_settings())
            with pytest.raises(httpx.ConnectError):
                await verifier._fetch_store()


# ── create_verifier factory ────────────────────────────────────────────────────


class TestCreateVerifierFactory:
    def _make_settings(self, sm_type: str):
        s = MagicMock()
        s.secret_manager_type = sm_type
        return s

    def test_static_type_returns_static(self) -> None:
        from server.credential_verifier import StaticCredentialVerifier, create_verifier

        result = create_verifier(self._make_settings("static"))
        assert isinstance(result, StaticCredentialVerifier)

    def test_openbao_type_returns_openbao(self) -> None:
        from server.credential_verifier import OpenBaoCredentialVerifier, create_verifier

        result = create_verifier(self._make_settings("openbao"))
        assert isinstance(result, OpenBaoCredentialVerifier)


# ── VerifiedIdentity ──────────────────────────────────────────────────────────


class TestVerifiedIdentity:
    def test_equality(self) -> None:
        from server.credential_verifier import VerifiedIdentity

        assert VerifiedIdentity("a") == VerifiedIdentity("a")
        assert VerifiedIdentity("a") != VerifiedIdentity("b")

    def test_immutable(self) -> None:
        from server.credential_verifier import VerifiedIdentity

        identity = VerifiedIdentity("label")
        with pytest.raises((AttributeError, TypeError)):
            identity.label = "other"  # type: ignore[misc]


# ── CredentialStore defaults ──────────────────────────────────────────────────


class TestCredentialStoreDefaults:
    def test_default_empty_store(self) -> None:
        from server.credential_verifier import CredentialStore

        store = CredentialStore()
        assert store.api_keys == {}
        assert store.cert_labels == {}
        assert store.mqtt_password_hash is None

    def test_fetched_at_is_recent(self) -> None:
        from server.credential_verifier import CredentialStore

        before = time.monotonic()
        store = CredentialStore()
        after = time.monotonic()
        assert before <= store.fetched_at <= after


# need httpx imported for the network error tests
import httpx  # noqa: E402
