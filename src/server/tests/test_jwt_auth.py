"""JWT bearer authentication for the ingest endpoint.

Covers the unit verifier (`_verify_jwt` / `StaticCredentialVerifier.verify_jwt`)
and the end-to-end route path, including the algorithm-confusion guard.
"""

from __future__ import annotations

import json
import logging
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from server.credential_verifier import JwtConfig, _verify_jwt

from .conftest import JWT_HMAC_SECRET

HS_SECRET = "unit-test-hs-secret"


def _hs_token(claims: dict, secret: str = HS_SECRET) -> str:
    return jwt.encode(claims, secret, algorithm="HS256")


@pytest.fixture(scope="module")
def rsa_keys() -> tuple[str, str]:
    """(private_pem, public_pem) for RS256 tests."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_pem = (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    return private_pem, public_pem


class TestVerifyJwtUnit:
    async def test_disabled_when_no_material(self) -> None:
        token = _hs_token({"sub": "x", "exp": time.time() + 60})
        assert await _verify_jwt(token, JwtConfig()) is None

    async def test_valid_hs256_maps_claim_to_label(self) -> None:
        cfg = JwtConfig(hmac_secret=HS_SECRET, labels={"ci-bot": "ci"})
        token = _hs_token({"sub": "ci-bot", "exp": time.time() + 60})
        identity = await _verify_jwt(token, cfg)
        assert identity is not None and identity.label == "ci"

    async def test_unmapped_claim_uses_claim_value(self) -> None:
        cfg = JwtConfig(hmac_secret=HS_SECRET)
        token = _hs_token({"sub": "team-x", "exp": time.time() + 60})
        identity = await _verify_jwt(token, cfg)
        assert identity is not None and identity.label == "team-x"

    async def test_expired_token_rejected(self) -> None:
        cfg = JwtConfig(hmac_secret=HS_SECRET)
        token = _hs_token({"sub": "x", "exp": time.time() - 1})
        assert await _verify_jwt(token, cfg) is None

    async def test_missing_exp_rejected(self) -> None:
        cfg = JwtConfig(hmac_secret=HS_SECRET)
        token = _hs_token({"sub": "x"})
        assert await _verify_jwt(token, cfg) is None

    async def test_bad_signature_rejected(self) -> None:
        cfg = JwtConfig(hmac_secret=HS_SECRET)
        token = _hs_token({"sub": "x", "exp": time.time() + 60}, secret="wrong-secret")
        assert await _verify_jwt(token, cfg) is None

    async def test_issuer_and_audience_enforced(self) -> None:
        cfg = JwtConfig(hmac_secret=HS_SECRET, issuer="mallard", audience="ingest")
        good = _hs_token({"sub": "x", "iss": "mallard", "aud": "ingest", "exp": time.time() + 60})
        assert (await _verify_jwt(good, cfg)) is not None
        bad_iss = _hs_token({"sub": "x", "iss": "evil", "aud": "ingest", "exp": time.time() + 60})
        assert await _verify_jwt(bad_iss, cfg) is None

    async def test_valid_rs256(self, rsa_keys: tuple[str, str]) -> None:
        private_pem, public_pem = rsa_keys
        cfg = JwtConfig(public_key=public_pem, algorithms=("RS256",))
        token = jwt.encode({"sub": "svc", "exp": time.time() + 60}, private_pem, algorithm="RS256")
        identity = await _verify_jwt(token, cfg)
        assert identity is not None and identity.label == "svc"

    async def test_algorithm_confusion_blocked(self, rsa_keys: tuple[str, str]) -> None:
        """With only an RSA public key configured, an HS256 token (the shape of an
        algorithm-confusion forgery, where the attacker signs with the public-key
        bytes as an HMAC secret) must be rejected — HS* is never in the allowed
        algorithm set when asymmetric material is configured."""
        _private_pem, public_pem = rsa_keys
        cfg = JwtConfig(public_key=public_pem, algorithms=("RS256",))
        # Any HS256 token must be refused at decode because algorithms=["RS256"].
        forged = jwt.encode({"sub": "attacker", "exp": time.time() + 60}, "any-secret", algorithm="HS256")
        assert await _verify_jwt(forged, cfg) is None


class TestJwtRoute:
    def test_valid_jwt_authenticates_and_tags_source(
        self, jwt_client: TestClient, valid_payload: dict
    ) -> None:
        from unittest.mock import patch

        token = _hs_token({"sub": "ci-bot", "exp": time.time() + 60}, secret=JWT_HMAC_SECRET)
        with patch("server.routers.ingest.write_payload") as write_mock:
            response = jwt_client.post(
                "/api/v1/ingest",
                json=valid_payload,
                headers={"Authorization": f"Bearer {token}"},
            )
        assert response.status_code == 202
        assert write_mock.call_args.kwargs["source"] == "ci"

    def test_expired_jwt_rejected(self, jwt_client: TestClient, valid_payload: dict) -> None:
        token = _hs_token({"sub": "ci-bot", "exp": time.time() - 1}, secret=JWT_HMAC_SECRET)
        response = jwt_client.post(
            "/api/v1/ingest",
            json=valid_payload,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert response.status_code == 401

    def test_non_jwt_bearer_still_treated_as_api_key(
        self, client: TestClient, valid_payload: dict
    ) -> None:
        """When JWT isn't configured, a plain bearer token remains an API key."""
        response = client.post(
            "/api/v1/ingest",
            json=valid_payload,
            headers={"Authorization": "Bearer test-key-valid"},
        )
        assert response.status_code == 202


# ── JWKS: unknown-kid refetch rate limit ──────────────────────────────────────

JWKS_URL = "https://idp.example/.well-known/jwks.json"


class _FakeJwks:
    """Serves a mutable JWKS in place of the network, counting fetches."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, public_pem: str, kids: list[str]) -> None:
        self.fetches = 0
        self.public_pem = public_pem
        self.kids = kids
        fake = self

        def fetch_data(client):
            fake.fetches += 1
            jwks = fake.document()
            client.jwk_set_cache.put(jwks)
            return jwks

        monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", fetch_data)

    def document(self) -> dict:
        public_key = serialization.load_pem_public_key(self.public_pem.encode())
        keys = []
        for kid in self.kids:
            jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(public_key))
            jwk.update(kid=kid, use="sig", alg="RS256")
            keys.append(jwk)
        return {"keys": keys}


def _rs_token(private_pem: str, kid: str) -> str:
    return jwt.encode(
        {"sub": "svc", "exp": time.time() + 60}, private_pem, algorithm="RS256", headers={"kid": kid}
    )


class TestJwksUnknownKid:
    @pytest.fixture(autouse=True)
    def _fresh_client_cache(self):
        from server.credential_verifier import _jwks_client

        _jwks_client.cache_clear()
        yield
        _jwks_client.cache_clear()

    async def test_unknown_kid_does_not_refetch_the_jwks_per_request(
        self, rsa_keys: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Every junk token carries a free, attacker-chosen kid; the stock client
        answered each with a fresh HTTP fetch against the identity provider."""
        private_pem, public_pem = rsa_keys
        fake = _FakeJwks(monkeypatch, public_pem, ["k1"])
        cfg = JwtConfig(jwks_url=JWKS_URL, algorithms=("RS256",))

        for i in range(10):
            assert await _verify_jwt(_rs_token(private_pem, f"unknown-{i}"), cfg) is None

        # One fetch to load the set, at most one forced refetch for the first miss.
        assert fake.fetches <= 2
        # ...and a legitimate kid keeps verifying.
        assert await _verify_jwt(_rs_token(private_pem, "k1"), cfg) is not None

    async def test_rotated_key_is_picked_up_once_the_window_passes(
        self, rsa_keys: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import types

        import server.credential_verifier as cv

        clock = types.SimpleNamespace(now=1000.0)
        monkeypatch.setattr(cv, "time", types.SimpleNamespace(monotonic=lambda: clock.now))
        private_pem, public_pem = rsa_keys
        fake = _FakeJwks(monkeypatch, public_pem, ["old"])
        client = cv._RateLimitedJwksClient(JWKS_URL, min_refetch_seconds=60)

        client.get_signing_key("old")
        fake.kids = ["old", "new"]  # the provider rotates in a new key
        assert client.get_signing_key("new").key_id == "new"  # the first miss may refetch

        fake.kids = ["old", "new", "newer"]
        fetches_before = fake.fetches
        with pytest.raises(jwt.PyJWKClientError):  # a second miss inside the window must not
            client.get_signing_key("newer")
        assert fake.fetches == fetches_before

        clock.now += 61.0  # window passed: the next miss may refetch again
        assert client.get_signing_key("newer").key_id == "newer"

    async def test_key_removed_from_jwks_stops_verifying(
        self, rsa_keys: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A per-kid LRU with no expiry kept a revoked key valid until restart."""
        private_pem, public_pem = rsa_keys
        fake = _FakeJwks(monkeypatch, public_pem, ["k1"])
        cfg = JwtConfig(jwks_url=JWKS_URL, algorithms=("RS256",))
        token = _rs_token(private_pem, "k1")
        assert await _verify_jwt(token, cfg) is not None

        from server.credential_verifier import _jwks_client

        fake.kids = ["k2"]  # k1 revoked at the provider
        _jwks_client(JWKS_URL).jwk_set_cache.put(None)  # the 5-minute set cache lapses
        assert await _verify_jwt(token, cfg) is None


# ── JWKS without issuer/audience pinning ──────────────────────────────────────


class TestJwksPinningWarning:
    def _warnings(self, caplog: pytest.LogCaptureFixture) -> list[str]:
        return [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING and "JWKS" in r.getMessage()]

    @pytest.mark.parametrize(
        ("issuer", "audience", "expect"),
        [
            ("", "", "JWT_ISSUER and JWT_AUDIENCE"),
            ("https://idp.example", "", "JWT_AUDIENCE is not"),
            ("", "mallard", "JWT_ISSUER is not"),
        ],
    )
    def test_startup_warns_when_jwks_is_not_pinned(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
        issuer: str, audience: str, expect: str,
    ) -> None:
        settings = self._settings(monkeypatch, JWT_JWKS_URL=JWKS_URL, JWT_ISSUER=issuer, JWT_AUDIENCE=audience)
        from server.credential_verifier import create_verifier

        with caplog.at_level(logging.WARNING):
            create_verifier(settings)
        assert any(expect in m for m in self._warnings(caplog))

    def test_no_warning_when_issuer_and_audience_are_pinned(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        settings = self._settings(
            monkeypatch, JWT_JWKS_URL=JWKS_URL, JWT_ISSUER="https://idp.example", JWT_AUDIENCE="mallard"
        )
        from server.credential_verifier import create_verifier

        with caplog.at_level(logging.WARNING):
            create_verifier(settings)
        assert self._warnings(caplog) == []

    def test_no_warning_without_a_jwks_url(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        settings = self._settings(monkeypatch, JWT_HMAC_SECRET=JWT_HMAC_SECRET)
        from server.credential_verifier import create_verifier

        with caplog.at_level(logging.WARNING):
            create_verifier(settings)
        assert self._warnings(caplog) == []

    async def test_remote_store_warns_once_per_config_change(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        from unittest.mock import AsyncMock, MagicMock, patch

        from server.credential_verifier import CredentialStore, OpenBaoCredentialVerifier

        verifier = OpenBaoCredentialVerifier(MagicMock(), ttl_seconds=0)
        store = lambda: CredentialStore(jwt=JwtConfig(jwks_url=JWKS_URL))  # noqa: E731
        with caplog.at_level(logging.WARNING), patch.object(
            verifier, "_fetch_store", new=AsyncMock(side_effect=[store(), store()])
        ):
            await verifier._get_store()
            verifier._store.fetched_at -= 100  # force a second refresh
            await verifier._get_store()
        assert len(self._warnings(caplog)) == 1

    @staticmethod
    def _settings(monkeypatch: pytest.MonkeyPatch, **env: str):
        from .conftest import _patch_env_and_settings

        _patch_env_and_settings(monkeypatch)
        for key in ("JWT_JWKS_URL", "JWT_ISSUER", "JWT_AUDIENCE", "JWT_HMAC_SECRET"):
            monkeypatch.delenv(key, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        from server.config import get_settings

        return get_settings()
