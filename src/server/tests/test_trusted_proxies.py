"""Tests for X-Forwarded-For handling in the pre-auth rate-limit key.

Behind a reverse proxy every connection carries the proxy's IP; without XFF
handling the per-IP limiter collapses into one shared bucket. The key function
must only trust XFF presented by peers on TRUSTED_PROXIES, and must resolve to
the right-most untrusted hop so clients can't mint buckets with junk values.
"""

from __future__ import annotations

import ipaddress
import os
from types import SimpleNamespace

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st
from starlette.datastructures import Headers

# server.main builds the FastAPI app at import time, which constructs Settings —
# provide the required env before the import (same pattern as tests/fuzz).
os.environ.setdefault("INFLUX_URL", "http://influxdb-test:8086")
os.environ.setdefault("INFLUX_TOKEN", "testtoken")

from server.main import _client_ip_from_xff, _get_key_for_rate_limit  # noqa: E402


def _nets(*cidrs: str) -> list:
    return [ipaddress.ip_network(c) for c in cidrs]


class TestClientIpFromXff:
    def test_rightmost_untrusted_hop_wins(self) -> None:
        trusted = _nets("10.0.0.0/8")
        assert _client_ip_from_xff("1.2.3.4, 10.0.0.7", trusted) == "1.2.3.4"

    def test_client_prepended_junk_ip_is_ignored(self) -> None:
        # The client sent "9.9.9.9" itself; the proxy appended the real peer.
        trusted = _nets("10.0.0.0/8")
        assert _client_ip_from_xff("9.9.9.9, 1.2.3.4, 10.0.0.7", trusted) == "1.2.3.4"

    def test_all_hops_trusted_returns_none(self) -> None:
        trusted = _nets("10.0.0.0/8")
        assert _client_ip_from_xff("10.1.1.1, 10.0.0.7", trusted) is None

    def test_malformed_hop_returns_none(self) -> None:
        trusted = _nets("10.0.0.0/8")
        assert _client_ip_from_xff("not-an-ip, 10.0.0.7", trusted) is None
        assert _client_ip_from_xff("1.2.3.4, garbage", trusted) is None

    def test_empty_header_returns_none(self) -> None:
        assert _client_ip_from_xff("", _nets("10.0.0.0/8")) is None
        assert _client_ip_from_xff(" , ,", _nets("10.0.0.0/8")) is None

    def test_ipv6_hops(self) -> None:
        trusted = _nets("fd00::/8")
        assert _client_ip_from_xff("2001:db8::1, fd00::7", trusted) == "2001:db8::1"


def _request(peer: str | None, headers: dict[str, str] | list[tuple[str, str]] | None = None):
    """A request double carrying real Starlette Headers (the key function reads
    repeated header lines with getlist, which a plain dict can't model). Pass a
    list of pairs to send the same header on several lines."""
    items = headers.items() if isinstance(headers, dict) else (headers or [])
    return SimpleNamespace(
        client=SimpleNamespace(host=peer) if peer else None,
        headers=Headers(raw=[(k.lower().encode(), v.encode()) for k, v in items]),
    )


@pytest.fixture()
def trusted_proxy_settings(monkeypatch: pytest.MonkeyPatch):
    from .conftest import _patch_env_and_settings

    _patch_env_and_settings(monkeypatch)
    monkeypatch.setenv("TRUSTED_PROXIES", "10.0.0.0/8")
    import server.config as config_module

    monkeypatch.setattr(config_module, "_settings", None)
    yield
    monkeypatch.setattr(config_module, "_settings", None)


class TestGetKeyForRateLimit:
    def test_xff_used_when_peer_is_trusted_proxy(self, trusted_proxy_settings) -> None:
        req = _request("10.0.0.7", {"x-forwarded-for": "1.2.3.4"})
        assert _get_key_for_rate_limit(req) == "1.2.3.4"

    def test_xff_ignored_from_untrusted_peer(self, trusted_proxy_settings) -> None:
        req = _request("42.42.42.42", {"x-forwarded-for": "1.2.3.4"})
        assert _get_key_for_rate_limit(req) == "42.42.42.42"

    def test_peer_used_when_no_xff(self, trusted_proxy_settings) -> None:
        assert _get_key_for_rate_limit(_request("10.0.0.7")) == "10.0.0.7"

    def test_peer_used_when_xff_malformed(self, trusted_proxy_settings) -> None:
        req = _request("10.0.0.7", {"x-forwarded-for": "junk-value"})
        assert _get_key_for_rate_limit(req) == "10.0.0.7"

    def test_no_client_returns_unknown(self, trusted_proxy_settings) -> None:
        assert _get_key_for_rate_limit(_request(None)) == "unknown"

    def test_hops_spread_over_several_header_lines_are_all_read(self, trusted_proxy_settings) -> None:
        """A proxy may append its hop as a *second* X-Forwarded-For line. The
        client controls the first line; reading only that one keyed the limiter
        on the client's own claim."""
        req = _request(
            "10.0.0.7",
            [("X-Forwarded-For", "9.9.9.9"), ("X-Forwarded-For", "1.2.3.4, 10.0.0.9")],
        )
        assert _get_key_for_rate_limit(req) == "1.2.3.4"

    def test_spoofed_first_line_cannot_pick_the_bucket(self, trusted_proxy_settings) -> None:
        spoofed = _request("10.0.0.7", [("X-Forwarded-For", "6.6.6.6"), ("X-Forwarded-For", "1.2.3.4")])
        honest = _request("10.0.0.7", [("X-Forwarded-For", "1.2.3.4")])
        assert _get_key_for_rate_limit(spoofed) == _get_key_for_rate_limit(honest) == "1.2.3.4"

    def test_multiple_values_on_one_line_use_the_rightmost_untrusted(self, trusted_proxy_settings) -> None:
        req = _request("10.0.0.7", {"X-Forwarded-For": "9.9.9.9, 1.2.3.4, 10.0.0.9, 10.0.0.8"})
        assert _get_key_for_rate_limit(req) == "1.2.3.4"

    def test_all_hops_trusted_across_lines_falls_back_to_peer(self, trusted_proxy_settings) -> None:
        req = _request("10.0.0.7", [("X-Forwarded-For", "10.1.1.1"), ("X-Forwarded-For", "10.0.0.9")])
        assert _get_key_for_rate_limit(req) == "10.0.0.7"

    @given(
        hops=st.lists(
            st.one_of(
                st.integers(1, 223).map(lambda n: f"{n}.1.2.3" if n != 10 else "11.1.2.3"),  # untrusted
                st.integers(0, 255).map(lambda n: f"10.0.0.{n}"),  # trusted proxy range
            ),
            min_size=1,
            max_size=8,
        ),
        cuts=st.lists(st.integers(0, 8), max_size=4),
    )
    # The fixture only sets idempotent process state, so reusing it across examples is safe.
    @settings(suppress_health_check=[HealthCheck.function_scoped_fixture])
    def test_any_split_into_lines_resolves_like_the_flat_chain(
        self, trusted_proxy_settings, hops: list[str], cuts: list[int]
    ) -> None:
        """The header lines of a request are one comma-joined chain, however a
        sender happened to split it: the key is the right-most untrusted hop."""
        bounds = sorted({0, len(hops), *(c for c in cuts if c < len(hops))})
        lines = [("X-Forwarded-For", ",".join(hops[a:b])) for a, b in zip(bounds, bounds[1:])]
        expected = _client_ip_from_xff(", ".join(hops), _nets("10.0.0.0/8")) or "10.0.0.7"
        assert _get_key_for_rate_limit(_request("10.0.0.7", lines)) == expected

    def test_without_trusted_proxies_peer_always_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from .conftest import _patch_env_and_settings

        _patch_env_and_settings(monkeypatch)
        monkeypatch.delenv("TRUSTED_PROXIES", raising=False)
        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        req = _request("10.0.0.7", {"x-forwarded-for": "1.2.3.4"})
        assert _get_key_for_rate_limit(req) == "10.0.0.7"


class TestTrustedProxiesConfig:
    def test_invalid_cidr_fails_fast(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from .conftest import _patch_env_and_settings

        _patch_env_and_settings(monkeypatch)
        monkeypatch.setenv("TRUSTED_PROXIES", "not-a-cidr")
        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        from server.config import get_settings

        with pytest.raises(ValueError, match="TRUSTED_PROXIES"):
            _ = get_settings().parsed_trusted_proxies
