"""
Hypothesis property-based fuzz tests for POST /api/v1/ingest.

Invariant: the server MUST NEVER return a 5xx response on arbitrary input.
All server-side errors should be client errors (4xx).
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings, strategies as st


def _make_test_client() -> TestClient:
    """Build a fresh TestClient with mocked InfluxDB."""
    import importlib
    import os

    # Ensure env vars are set
    os.environ.setdefault("INFLUX_URL", "http://influxdb-test:8086")
    os.environ.setdefault("INFLUX_TOKEN", "testtoken")
    os.environ.setdefault("INFLUX_ORG", "mallard")
    os.environ.setdefault("INFLUX_BUCKET", "metrics")
    os.environ.setdefault("API_KEYS", "test-key-valid")
    os.environ.setdefault("RATE_LIMIT", "100000/minute")
    os.environ.setdefault("SECRET_MANAGER_TYPE", "openbao")
    os.environ.setdefault("SECRET_MANAGER_URL", "http://secret-manager-test:8200")
    os.environ.setdefault("SECRET_MANAGER_TOKEN", "test-sm-token")

    import server.config as config_module

    config_module._settings = None

    mock_client = MagicMock()
    mock_client.ping.return_value = True
    mock_write_api = MagicMock()
    # write() is awaited by write_payload — a plain MagicMock makes every
    # successfully-normalized batch 503 before reaching the sanitization code
    # the structured fuzz below is meant to exercise.
    mock_write_api.write = AsyncMock(return_value=True)
    mock_client.write_api.return_value = mock_write_api

    with patch("server.influx.make_client", return_value=mock_client):
        import server.main as main_module

        importlib.reload(main_module)
        app = main_module.create_app()
        from server.config import get_settings

        from server.credential_verifier import StaticCredentialVerifier

        settings = get_settings()
        app.state.settings = settings
        app.state.influx_client = mock_client
        app.state.write_api = mock_write_api
        app.state.verifier = StaticCredentialVerifier(settings)
        return TestClient(app, raise_server_exceptions=False)


# Build the client once at module level to avoid rebuilding for every hypothesis example
_fuzz_client = _make_test_client()


@given(body=st.binary(max_size=65536))
@settings(
    max_examples=200,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=None,
)
def test_arbitrary_binary_body_never_causes_5xx(body: bytes) -> None:
    """POST arbitrary bytes — server must return 4xx, never 5xx."""
    response = _fuzz_client.post(
        "/api/v1/ingest",
        content=body,
        headers={"X-API-Key": "test-key-valid", "Content-Type": "application/json"},
    )
    assert response.status_code < 500, (
        f"Server returned {response.status_code} for body={body[:50]!r}…\n"
        f"Response: {response.text[:200]}"
    )


@given(body=st.binary(max_size=65536))
@settings(
    max_examples=100,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=None,
)
def test_arbitrary_body_without_auth_returns_401_or_4xx(body: bytes) -> None:
    """Without an API key, server must return 401 (or 413 for oversized), never 5xx."""
    response = _fuzz_client.post(
        "/api/v1/ingest",
        content=body,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code < 500, (
        f"Server returned {response.status_code} without auth\n"
        f"Response: {response.text[:200]}"
    )


@given(
    data=st.dictionaries(
        keys=st.text(max_size=50),
        values=st.one_of(
            st.none(),
            st.booleans(),
            st.integers(),
            st.floats(allow_nan=False, allow_infinity=False),
            st.text(max_size=100),
            st.lists(st.text(max_size=20), max_size=10),
        ),
        max_size=20,
    )
)
@settings(
    max_examples=200,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=None,
)
def test_arbitrary_json_dict_never_causes_5xx(data: dict) -> None:
    """POST arbitrary JSON objects — validation should catch them without crashing."""
    response = _fuzz_client.post(
        "/api/v1/ingest",
        json=data,
        headers={"X-API-Key": "test-key-valid"},
    )
    assert response.status_code < 500, (
        f"Server returned {response.status_code} for data={data}\n"
        f"Response: {response.text[:200]}"
    )


# ── Structured payload fuzz: exercise normalize → influx write ────────────────
# The flat-dict strategy above almost never produces a valid `events` list, so
# normalize_payload/write_payload (tag sanitization, cost_by_category caps)
# were barely fuzzed. This strategy generates valid-SHAPED payloads with
# adversarial field values.

_event_strategy = st.fixed_dictionaries(
    {},
    optional={
        "id": st.text(max_size=64),
        "ts": st.one_of(
            st.integers(),
            st.floats(allow_nan=False, allow_infinity=False),
            st.text(max_size=24),
        ),
        "connector": st.text(max_size=100),
        "model": st.text(max_size=100),
        "surface": st.text(max_size=100),
        "credits": st.one_of(st.floats(allow_nan=False, allow_infinity=False), st.text(max_size=12)),
        "cost_usd": st.one_of(st.floats(allow_nan=False, allow_infinity=False), st.integers()),
        "estimated": st.booleans(),
        "language": st.text(max_size=60),
        "repo": st.text(max_size=140),
        "branch": st.text(max_size=140),
        "attribution": st.text(max_size=60),
        "prompt_tokens": st.one_of(st.integers(), st.text(max_size=12)),
        "completion_tokens": st.integers(),
        "cost_by_category": st.dictionaries(
            keys=st.text(max_size=40),
            values=st.floats(allow_nan=False, allow_infinity=False),
            max_size=48,
        ),
        "unexpected_extra": st.text(max_size=40),
    },
)

_valid_shaped_payload = st.fixed_dictionaries(
    {
        "schema_version": st.integers(min_value=0, max_value=9),
        "events": st.lists(_event_strategy, max_size=5),
    },
    optional={
        "instance_id": st.one_of(st.none(), st.text(max_size=48)),
        "sent_at": st.integers(),
        "tz_offset_minutes": st.one_of(st.none(), st.integers(min_value=-900, max_value=900)),
    },
)


@given(payload=_valid_shaped_payload)
@settings(
    max_examples=200,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=None,
)
def test_valid_shaped_payload_with_adversarial_values_never_causes_5xx(payload: dict) -> None:
    """Well-shaped batches with hostile field values must ingest or 4xx — never 5xx."""
    response = _fuzz_client.post(
        "/api/v1/ingest",
        json=payload,
        headers={"X-API-Key": "test-key-valid"},
    )
    assert response.status_code < 500, (
        f"Server returned {response.status_code} for payload={json.dumps(payload)[:300]}\n"
        f"Response: {response.text[:200]}"
    )


@given(payload=_valid_shaped_payload)
@settings(
    max_examples=150,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=None,
)
def test_normalize_and_write_never_raise_on_valid_shape(payload: dict) -> None:
    """normalize_payload → write_payload directly: tag sanitization and the
    cost_by_category field cap must hold for any adversarial values."""
    import asyncio

    from unittest.mock import AsyncMock

    from server.influx import write_payload
    from server.normalize import PayloadOutOfRange, normalize_payload

    try:
        batch = normalize_payload(payload)
    except PayloadOutOfRange:
        # Values InfluxDB can't store are rejected up front (a 422 on the route,
        # covered by test_out_of_range_values_get_422_and_the_rest_202 below), so
        # they never reach the writer this test is about.
        return
    write_api = MagicMock()
    write_api.write = AsyncMock(return_value=True)
    asyncio.run(
        write_payload(write_api=write_api, bucket="b", org="o", batch=batch, source="fuzz")
    )
    # Every write call must carry points bounded by the dynamic-field cap.
    for call in write_api.write.call_args_list:
        for point in call.kwargs.get("record", []):
            cbc_fields = [k for k in point._fields if str(k).startswith("cbc_")]
            assert len(cbc_fields) <= 32, f"field cap breached: {len(cbc_fields)}"


# ── Content-Length header fuzz ────────────────────────────────────────────────


@given(value=st.text(max_size=24))
@settings(
    max_examples=100,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=None,
)
def test_content_length_values_never_cause_5xx(value: str) -> None:
    """Arbitrary Content-Length strings hit the int() guard, not a 500.

    Sent as X-Original-Content-Length equivalents is not enough — we go
    through the real header. httpx refuses headers with newlines/control
    chars, so restrict to what can legally appear on the wire.
    """
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in value) or "\n" in value or "\r" in value:
        return
    try:
        response = _fuzz_client.post(
            "/api/v1/ingest",
            content=b"{}",
            headers={
                "X-API-Key": "test-key-valid",
                "Content-Type": "application/json",
                "Content-Length": value,
            },
        )
    except Exception:
        # The HTTP client itself may reject an unsendable header — fine;
        # the server never saw it.
        return
    assert response.status_code < 500, (
        f"Server returned {response.status_code} for Content-Length={value!r}"
    )


# ── Auth parser fuzz ──────────────────────────────────────────────────────────


@given(header=st.text(max_size=120))
@settings(max_examples=200, deadline=None)
def test_extract_cert_cn_never_raises(header: str) -> None:
    """DN parsing accepts arbitrary junk and returns '' or a safe CN."""
    from server.routers.ingest import _CERT_CN_RE, _extract_cert_cn

    cn = _extract_cert_cn(header)
    assert cn == "" or _CERT_CN_RE.match(cn), f"unsafe CN extracted: {cn!r}"


@given(token=st.text(max_size=200))
@settings(
    max_examples=150,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=None,
)
def test_arbitrary_bearer_tokens_never_cause_5xx(token: str) -> None:
    """Fuzz the JWT/bearer decode path via the Authorization header."""
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in token):
        return
    try:
        response = _fuzz_client.post(
            "/api/v1/ingest",
            content=b"{}",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
    except Exception:
        return
    assert response.status_code < 500, (
        f"Server returned {response.status_code} for bearer={token[:60]!r}"
    )


# ── MQTT ingest path fuzz ─────────────────────────────────────────────────────


@given(
    topic=st.text(max_size=80),
    data=st.one_of(st.binary(max_size=70_000), st.none()),
    client_id=st.text(max_size=40),
)
@settings(
    max_examples=200,
    suppress_health_check=[HealthCheck.too_slow],
    deadline=None,
)
def test_mqtt_handle_message_never_raises(topic: str, data: bytes | None, client_id: str) -> None:
    """_handle_message must drop out-of-scope/oversized/malformed messages
    without raising — an exception here would take down the broker plugin."""
    import asyncio

    from unittest.mock import AsyncMock

    from server.config import get_settings
    from server.mqtt import BrokerContext, _handle_message
    from server.rate_limit import SlidingWindowLimiter

    msg = MagicMock()
    msg.topic = topic
    msg.data = data

    write_api = MagicMock()
    write_api.write = AsyncMock(return_value=True)
    ctx = BrokerContext(
        settings=get_settings(),
        write_api=write_api,
        verifier=MagicMock(),
        limiter=SlidingWindowLimiter(1_000_000, 60),
    )
    asyncio.run(_handle_message(msg, client_id, ctx))


# ── Range, integer-literal, signature and tag fuzz ────────────────────────────
# These reach the paths the strategies above miss: numbers outside what InfluxDB
# can store, integer literals past CPython's 4300-digit parse limit, hostile
# signature headers (the fuzz client above has no HMAC secrets configured, so
# _verify_signature was never exercised) and instance_id / schema_version tags.

_MAX_TS_MS = (2**63 - 1) // 1_000_000
_MAX_INT = 2**63 - 1
_BOUNDARIES = [-1, 0, 1, _MAX_TS_MS, _MAX_TS_MS + 1, _MAX_INT, _MAX_INT + 1]
_wide_ints = st.one_of(
    st.integers(min_value=-(2**70), max_value=2**70),
    st.sampled_from(_BOUNDARIES),
)


def _ok_ts(ts: int) -> bool:
    return 0 <= ts <= _MAX_TS_MS


def _ok_tokens(n: int) -> bool:
    return 0 <= n <= _MAX_INT


@given(ts=_wide_ints, tokens=_wide_ints)
@settings(max_examples=300, suppress_health_check=[HealthCheck.too_slow], deadline=None)
def test_out_of_range_values_get_422_and_the_rest_202(ts: int, tokens: int) -> None:
    """Exactly the values InfluxDB can store are accepted; everything else is a 422."""
    response = _fuzz_client.post(
        "/api/v1/ingest",
        json={"schema_version": 1, "events": [{"ts": ts, "prompt_tokens": tokens}]},
        headers={"X-API-Key": "test-key-valid"},
    )
    expected = 202 if _ok_ts(ts) and _ok_tokens(tokens) else 422
    assert response.status_code == expected, f"ts={ts} tokens={tokens}"


@given(
    field=st.sampled_from(["ts", "credits", "cost_usd", "prompt_tokens", "sent_at", "schema_version"]),
    digits=st.integers(min_value=4280, max_value=4330),
)
@settings(max_examples=120, suppress_health_check=[HealthCheck.too_slow], deadline=None)
def test_huge_integer_literals_never_cause_5xx(field: str, digits: int) -> None:
    """Integer literals around CPython's 4300-digit limit: the parser raises
    ValueError past it, and float() overflows well before it."""
    literal = "9" * digits
    if field in ("sent_at", "schema_version"):
        body = '{"schema_version": %s, "sent_at": %s, "events": []}' % (
            literal if field == "schema_version" else "1",
            literal if field == "sent_at" else "1",
        )
    else:
        body = '{"schema_version": 1, "events": [{"%s": %s}]}' % (field, literal)
    response = _fuzz_client.post(
        "/api/v1/ingest",
        content=body.encode(),
        headers={"X-API-Key": "test-key-valid", "Content-Type": "application/json"},
    )
    assert response.status_code in (202, 400, 422), f"{field} x{digits}: {response.status_code}"
    if digits > 4300:
        assert response.status_code == 400  # unparseable, never a 500


def _make_hmac_client() -> TestClient:
    """Like _make_test_client, but the verifier enforces X-Mallard-Signature-256."""
    from types import SimpleNamespace

    from server.credential_verifier import StaticCredentialVerifier

    base = _make_test_client()
    real = base.app.state.settings
    base.app.state.verifier = StaticCredentialVerifier(
        SimpleNamespace(
            hashed_api_keys=real.hashed_api_keys,
            mqtt_password="",
            parsed_jwt=real.parsed_jwt,
            parsed_cert_labels={},
            parsed_webhook_hmac_secrets=["fuzz-secret"],
        )
    )
    return base


_hmac_fuzz_client = _make_hmac_client()


@given(raw=st.binary(max_size=200).filter(lambda b: not any(c in b for c in (b"\r", b"\n", b"\x00"))))
@settings(max_examples=300, suppress_health_check=[HealthCheck.too_slow], deadline=None)
def test_arbitrary_signature_header_bytes_are_401_never_5xx(raw: bytes) -> None:
    """Any header value — including non-ASCII, which made compare_digest raise
    TypeError (a 500) — is just an invalid signature."""
    response = _hmac_fuzz_client.post(
        "/api/v1/ingest",
        content=b'{"schema_version": 1, "events": []}',
        headers={
            "X-API-Key": "test-key-valid",
            "Content-Type": "application/json",
            "X-Mallard-Signature-256": raw,
        },
    )
    assert response.status_code == 401, raw


@given(header=st.text(max_size=120), body=st.binary(max_size=64))
@settings(max_examples=300, deadline=None)
def test_verify_signature_total_over_unicode(header: str, body: bytes) -> None:
    """_verify_signature returns a bool for any str (non-ASCII included), never
    accepts a header that isn't a real MAC, and still accepts the real one."""
    import hashlib
    import hmac as hmac_mod

    from server.routers.ingest import _verify_signature

    good = "sha256=" + hmac_mod.new(b"s3cret", body, hashlib.sha256).hexdigest()
    result = _verify_signature(body, header, ["s3cret"])
    assert isinstance(result, bool)
    if header != good:
        assert result is False or header.removeprefix("sha256=").strip().lower() == good.removeprefix("sha256=")
    assert _verify_signature(body, good, ["s3cret"]) is True


@given(instance_id=st.one_of(st.none(), st.text(max_size=300)), schema_version=_wide_ints)
@settings(max_examples=200, deadline=None)
def test_instance_id_and_schema_version_tags_are_sanitised(instance_id, schema_version: int) -> None:
    """Both come off the wire; they must be capped and charset-limited like every other tag."""
    import asyncio
    import re
    from unittest.mock import AsyncMock

    from server.influx import write_payload
    from server.normalize import NormalizedBatch, NormalizedEvent

    batch = NormalizedBatch(
        schema_version=schema_version,
        instance_id=instance_id,
        sent_at_ms=1,
        tz_offset_minutes=None,
        events=[NormalizedEvent(ts_ms=1, connector="c", model="m", surface="s", credits=0.0, cost_usd=0.0, estimated=True)],
    )
    write_api = MagicMock()
    write_api.write = AsyncMock(return_value=True)
    asyncio.run(write_payload(write_api=write_api, bucket="b", org="o", batch=batch))
    (point,) = write_api.write.call_args.kwargs["record"]
    for tag in ("instance_id", "schema_version"):
        value = point._tags[tag]
        assert re.fullmatch(r"[A-Za-z0-9._@ /_-]{1,64}", value), (tag, value)
