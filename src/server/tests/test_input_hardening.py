"""Regression tests for attacker-controlled input that used to escape the ingest
handler as a 500, and for the Redis rate-limiter outage path."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from .conftest import BrokenRedis


class TestRedisOutageFailsOpen:
    """redis.eval raising used to surface as a 500 on every ingest request. The
    per-credential limiter must fall open to a local limiter instead."""

    @staticmethod
    def _with_broken_redis(client: TestClient, limit: int):
        from server.rate_limit import RedisRateLimiter

        original = client.app.state.label_limiter
        client.app.state.label_limiter = RedisRateLimiter(BrokenRedis(), limit, 60)
        return original

    def test_ingest_accepted_when_redis_is_down(self, client: TestClient, valid_payload: dict) -> None:
        original = self._with_broken_redis(client, limit=1000)
        try:
            response = client.post(
                "/api/v1/ingest", json=valid_payload, headers={"X-API-Key": "test-key-valid"}
            )
        finally:
            client.app.state.label_limiter = original
        assert response.status_code == 202

    def test_limit_still_enforced_locally_when_redis_is_down(
        self, client: TestClient, valid_payload: dict
    ) -> None:
        original = self._with_broken_redis(client, limit=1)
        try:
            statuses = [
                client.post(
                    "/api/v1/ingest", json=valid_payload, headers={"X-API-Key": "test-key-valid"}
                ).status_code
                for _ in range(2)
            ]
        finally:
            client.app.state.label_limiter = original
        assert statuses == [202, 429]

    def test_readiness_stays_200_and_reports_degraded_limiter(self, client: TestClient) -> None:
        """A Redis outage must not drain every replica at once."""
        from server.rate_limit import RedisRateLimiter

        original = client.app.state.label_limiter
        client.app.state.label_limiter = RedisRateLimiter(BrokenRedis(), 10, 60)
        try:
            response = client.get("/health")
        finally:
            client.app.state.label_limiter = original
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["rate_limiter"] == "degraded"


class TestHostileInput:
    def _post(self, client: TestClient, body: bytes, **headers: str | bytes):
        return client.post(
            "/api/v1/ingest",
            content=body,
            headers={"X-API-Key": "test-key-valid", "Content-Type": "application/json", **headers},
        )

    def test_integer_beyond_python_digit_limit_returns_400(self, client: TestClient) -> None:
        # CPython refuses to parse >4300-digit ints: ValueError, which was a 500.
        body = b'{"schema_version": 1, "events": [], "x": ' + b"9" * 5000 + b"}"
        assert self._post(client, body).status_code == 400

    def test_deeply_nested_json_returns_400(self, client: TestClient) -> None:
        assert self._post(client, b"[" * 60_000).status_code == 400

    def test_non_ascii_signature_header_returns_401(
        self, hmac_client: TestClient, valid_payload: dict
    ) -> None:
        # compare_digest raises TypeError on a non-ASCII str: was a 500.
        body = json.dumps(valid_payload).encode()
        response = self._post(
            hmac_client, body, **{"X-Mallard-Signature-256": "sha256=café".encode("latin-1")}
        )
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid signature"

    def test_verify_signature_rejects_non_ascii_without_raising(self) -> None:
        from server.routers.ingest import _verify_signature

        assert _verify_signature(b"{}", "sha256=é中", ["secret"]) is False


class TestOutOfRangeValues:
    """Values InfluxDB can't store are rejected with 422 before the write."""

    @staticmethod
    def _post(client: TestClient, payload: dict):
        with patch("server.routers.ingest.write_payload") as write_mock:
            response = client.post(
                "/api/v1/ingest", json=payload, headers={"X-API-Key": "test-key-valid"}
            )
        return response, write_mock

    @pytest.mark.parametrize("ts", [10**15, 10**30, -1, 2**63])
    def test_out_of_range_event_ts_returns_422(
        self, client: TestClient, valid_payload: dict, ts: int
    ) -> None:
        valid_payload["events"][0]["ts"] = ts
        response, write_mock = self._post(client, valid_payload)
        assert response.status_code == 422
        write_mock.assert_not_called()

    @pytest.mark.parametrize("tokens", [2**63, 2**70, -1])
    def test_out_of_range_tokens_return_422(
        self, client: TestClient, valid_payload: dict, tokens: int
    ) -> None:
        valid_payload["events"][0]["prompt_tokens"] = tokens
        response, write_mock = self._post(client, valid_payload)
        assert response.status_code == 422
        write_mock.assert_not_called()

    def test_unrepresentable_float_returns_422(self, client: TestClient, valid_payload: dict) -> None:
        valid_payload["events"][0]["credits"] = 10**400  # float() overflows: was a 500
        response, write_mock = self._post(client, valid_payload)
        assert response.status_code == 422
        write_mock.assert_not_called()

    def test_non_finite_float_returns_422(self, client: TestClient) -> None:
        body = b'{"schema_version": 1, "events": [{"cost_usd": 1e999}]}'
        response = client.post(
            "/api/v1/ingest",
            content=body,
            headers={"X-API-Key": "test-key-valid", "Content-Type": "application/json"},
        )
        assert response.status_code == 422

    def test_both_sides_of_the_boundary(self, client: TestClient, valid_payload: dict) -> None:
        max_ts = (2**63 - 1) // 1_000_000
        valid_payload["events"][0]["ts"] = 0
        valid_payload["events"][0]["prompt_tokens"] = 2**63 - 1
        valid_payload["events"][1]["ts"] = max_ts
        response, write_mock = self._post(client, valid_payload)
        assert response.status_code == 202
        assert write_mock.call_count == 1

        valid_payload["events"][1]["ts"] = max_ts + 1
        response, _ = self._post(client, valid_payload)
        assert response.status_code == 422
