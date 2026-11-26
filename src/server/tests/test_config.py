"""Tests for Settings field validators and credential parsing."""

from __future__ import annotations

import hashlib

import pytest
from pydantic import ValidationError

# The static backend is the default; url/token are only required for openbao.
_SM_KWARGS: dict[str, str] = {}
_SM_ENV = {
    "SECRET_MANAGER_TYPE": "static",
}


def _set_sm_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for k, v in _SM_ENV.items():
        monkeypatch.setenv(k, v)


@pytest.fixture(autouse=True)
def _no_leaked_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Some other test modules (e.g. the fuzz suite) set process env vars via
    os.environ.setdefault() rather than monkeypatch, which never gets reverted
    within a pytest session. Direct Settings(...) construction in this file
    relies on specific fields being *absent* unless a test supplies them, so
    scrub anything that could leak in from an earlier test module."""
    for key in ("SECRET_MANAGER_TYPE", "SECRET_MANAGER_URL", "SECRET_MANAGER_TOKEN", "API_KEYS"):
        monkeypatch.delenv(key, raising=False)


class TestSettingsValidators:
    def test_empty_influx_url_raises(self) -> None:
        from server.config import Settings

        with pytest.raises(ValidationError, match="INFLUX_URL must not be empty"):
            Settings(influx_url="", influx_token="tok", **_SM_KWARGS)

    def test_whitespace_influx_url_raises(self) -> None:
        from server.config import Settings

        with pytest.raises(ValidationError, match="INFLUX_URL must not be empty"):
            Settings(influx_url="   ", influx_token="tok", **_SM_KWARGS)

    def test_valid_influx_url_is_stripped(self) -> None:
        from server.config import Settings

        s = Settings(influx_url="  http://x:8086  ", influx_token="tok", **_SM_KWARGS)
        assert s.influx_url == "http://x:8086"

    def test_secret_manager_type_defaults_to_static(self) -> None:
        from server.config import Settings

        s = Settings(influx_url="http://x:8086", influx_token="tok")
        assert s.secret_manager_type == "static"

    def test_infisical_is_not_an_accepted_secret_manager_type(self) -> None:
        from server.config import Settings

        with pytest.raises(ValidationError):
            Settings(
                influx_url="http://x:8086",
                influx_token="tok",
                secret_manager_type="infisical",  # type: ignore[arg-type]
            )

    def test_missing_secret_manager_url_raises(self) -> None:
        from server.config import Settings

        with pytest.raises(ValidationError, match="SECRET_MANAGER_URL must be set when SECRET_MANAGER_TYPE=openbao"):
            Settings(
                influx_url="http://x:8086",
                influx_token="tok",
                secret_manager_type="openbao",
                secret_manager_token="sm-token",
            )

    def test_missing_secret_manager_token_raises(self) -> None:
        from server.config import Settings

        with pytest.raises(ValidationError, match="SECRET_MANAGER_TOKEN must be set when SECRET_MANAGER_TYPE=openbao"):
            Settings(
                influx_url="http://x:8086",
                influx_token="tok",
                secret_manager_type="openbao",
                secret_manager_url="http://sm.example",
            )

    def test_openbao_with_url_and_token_succeeds(self) -> None:
        from server.config import Settings

        s = Settings(
            influx_url="http://x:8086",
            influx_token="tok",
            secret_manager_type="openbao",
            secret_manager_url="http://sm.example",
            secret_manager_token="sm-token",
        )
        assert s.secret_manager_type == "openbao"

    def test_static_needs_no_secret_manager_url_or_token(self) -> None:
        from server.config import Settings

        s = Settings(influx_url="http://x:8086", influx_token="tok", secret_manager_type="static")
        assert s.secret_manager_url == ""

    def test_api_keys_defaults_to_empty(self) -> None:
        from server.config import Settings

        s = Settings(influx_url="http://x:8086", influx_token="tok", **_SM_KWARGS)
        assert s.api_keys == ""


class TestParseLabeledDelegation:
    """config.py delegates label parsing to CredentialStore.parse_labeled, so the
    Settings path gets the same _LABEL_RE sanitisation as the remote verifiers.
    The parse itself is unit-tested in test_credential_verifier.py."""

    def test_settings_path_sanitises_invalid_labels(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        monkeypatch.setenv("API_KEYS", "bad label!:mykey")
        _set_sm_env(monkeypatch)

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()

        h = hashlib.sha256(b"mykey").hexdigest()
        assert settings.hashed_api_keys[h] == "unknown"

    def test_settings_path_sanitises_oversized_labels(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        monkeypatch.setenv("API_KEYS", f"{'x' * 65}:mykey")
        _set_sm_env(monkeypatch)

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()

        h = hashlib.sha256(b"mykey").hexdigest()
        assert settings.hashed_api_keys[h] == "unknown"

    def test_settings_path_matches_credential_store_parse(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from server.credential_verifier import CredentialStore

        raw = "team-alpha:key-a,bare-key,bad label!:key-b"
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        monkeypatch.setenv("API_KEYS", raw)
        _set_sm_env(monkeypatch)

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()

        assert settings.hashed_api_keys == CredentialStore.parse_labeled(raw)


class TestHashedCredentials:
    def test_hashed_api_keys_bare_format(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        monkeypatch.setenv("API_KEYS", "key-a,key-b")
        _set_sm_env(monkeypatch)

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()

        expected_a = hashlib.sha256(b"key-a").hexdigest()
        expected_b = hashlib.sha256(b"key-b").hexdigest()
        assert expected_a in settings.hashed_api_keys
        assert expected_b in settings.hashed_api_keys
        assert settings.hashed_api_keys[expected_a] == "unknown"

    def test_hashed_api_keys_labeled_format(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        monkeypatch.setenv("API_KEYS", "team-alpha:key-a,team-beta:key-b")
        _set_sm_env(monkeypatch)

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()

        expected_a = hashlib.sha256(b"key-a").hexdigest()
        expected_b = hashlib.sha256(b"key-b").hexdigest()
        assert settings.hashed_api_keys[expected_a] == "team-alpha"
        assert settings.hashed_api_keys[expected_b] == "team-beta"

    def test_plain_keys_not_stored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        monkeypatch.setenv("API_KEYS", "plain-text-key")
        _set_sm_env(monkeypatch)

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()

        assert "plain-text-key" not in settings.hashed_api_keys

    def test_mqtt_password_defaults_to_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        monkeypatch.setenv("API_KEYS", "k")
        _set_sm_env(monkeypatch)

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()
        assert settings.mqtt_password == ""

    def test_cert_labels_parsed_and_sanitised(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        monkeypatch.setenv("API_KEYS", "k")
        monkeypatch.setenv("CERT_LABELS", "team-a:machine-01,bad entry")
        _set_sm_env(monkeypatch)

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()
        assert settings.parsed_cert_labels == {"machine-01": "team-a"}

    def test_secret_manager_base_url_strips_trailing_slash(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        _set_sm_env(monkeypatch)
        monkeypatch.setenv("SECRET_MANAGER_URL", "http://openbao:8200/")

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()
        assert settings.secret_manager_base_url == "http://openbao:8200"

    def test_secret_manager_field_defaults(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INFLUX_URL", "http://localhost:8086")
        monkeypatch.setenv("INFLUX_TOKEN", "tok")
        _set_sm_env(monkeypatch)

        import server.config as config_module

        monkeypatch.setattr(config_module, "_settings", None)
        settings = config_module.get_settings()
        assert settings.secret_manager_type == "static"
        assert settings.openbao_secret_path == "secret/data/mallard/server"


class TestPlaceholderSecrets:
    """The shipped example files use CHANGE_ME values. They are non-empty, so
    compose's `${VAR:?required}` accepts them; the server must not."""

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("influx_token", "CHANGE_ME"),
            ("influx_token", "change-me-influx-api-token"),
            ("api_keys", "team-alpha:CHANGE_ME_api_key_1"),
            ("mqtt_password", "CHANGE_ME_mqtt_broker_password"),
            ("webhook_hmac_secrets", "old-secret,ChangeMe"),
            ("jwt_hmac_secret", "change_me"),
        ],
    )
    def test_placeholder_is_rejected_at_startup(self, field: str, value: str) -> None:
        from server.config import Settings

        kwargs = {"influx_url": "http://x:8086", "influx_token": "real-token", field: value}
        with pytest.raises(ValidationError, match="CHANGE_ME"):
            Settings(**kwargs)

    def test_error_names_every_offending_setting_but_not_the_value(self) -> None:
        from server.config import Settings

        with pytest.raises(ValidationError) as exc:
            Settings(influx_url="http://x:8086", influx_token="CHANGE_ME_secret-1", mqtt_password="change-me-2")
        message = str(exc.value)
        assert "INFLUX_TOKEN" in message and "MQTT_PASSWORD" in message
        assert "secret-1" not in message

    def test_dev_flag_allows_placeholders(self) -> None:
        from server.config import Settings

        s = Settings(influx_url="http://x:8086", influx_token="CHANGE_ME", allow_placeholder_secrets=True)
        assert s.influx_token == "CHANGE_ME"

    def test_real_secrets_pass(self) -> None:
        from server.config import Settings

        Settings(
            influx_url="http://x:8086",
            influx_token="a1b2c3d4e5",
            api_keys="team:s3cr3t",
            mqtt_password="hunter2hunter2",
        )

    def test_shipped_env_example_is_rejected_as_is(self) -> None:
        """Guard against a placeholder drifting away from the CHANGE_ME marker."""
        from pathlib import Path

        from server.config import Settings

        text = (Path(__file__).parents[1] / "docker" / ".env.example").read_text()
        env = dict(
            line.split("=", 1) for line in text.splitlines() if "=" in line and not line.startswith("#")
        )
        with pytest.raises(ValidationError, match="CHANGE_ME"):
            Settings(
                influx_url="http://x:8086",
                influx_token=env["INFLUX_TOKEN"],
                api_keys=env["API_KEYS"],
                mqtt_password=env["MQTT_PASSWORD"],
            )


class TestCredentialMaxStale:
    def test_default_is_24_hours(self) -> None:
        from server.config import Settings

        assert Settings(influx_url="http://x:8086", influx_token="t").credential_max_stale_seconds == 86400

    def test_negative_rejected(self) -> None:
        from server.config import Settings

        with pytest.raises(ValidationError):
            Settings(influx_url="http://x:8086", influx_token="t", credential_max_stale_seconds=-1)
