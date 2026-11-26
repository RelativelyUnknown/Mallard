# Authentication & Identity Reference

The self-hosted Mallard server supports five authentication methods, plus
optional HMAC request signing on top. The method you choose controls what the
extension sends and what `source` label is written to InfluxDB: the tag that
lets Grafana dashboards break down spend by team member, machine, or CI
pipeline without a separate configuration step per dashboard.

Labels are configured entirely server-side, in the secret manager. The
extension never sends a label — it sends a credential, and the server maps
that credential to whoever it was issued to. Think of it as a tracking cookie
the operator hands out: give team A key A, and everything sent with key A is
tagged `source=team-a`.

## Supported auth methods

| Method | Transport | What the extension sends | Server validates against |
|---|---|---|---|
| API key | HTTP webhook | `X-API-Key: <key>` header | `API_KEYS` in the secret store |
| Bearer token | HTTP webhook | `Authorization: Bearer <token>` | same store as API keys |
| JWT bearer | HTTP webhook | `Authorization: Bearer <jwt>` (signed, with `exp`) | `JWT_*` settings (shared secret, public key or JWKS) |
| mTLS certificate | HTTP webhook only | Client TLS certificate | CA trust + optional `CERT_LABELS` |
| MQTT password | MQTT/WSS | CONNECT password field | `MQTT_PASSWORD` (single shared) |

## API key

**Extension side:** run **Mallard: Set Webhook API Key** (stored in
SecretStorage; credentials never live in settings files).

The extension sends this header on every `POST /api/v1/ingest`:

```
X-API-Key: <api-key>
```

The key is looked up in the server's credential store. The label associated
with the key becomes the `source` tag in InfluxDB. Example store entry:
`team-alpha:key-abc123` → `source=team-alpha`.

## Bearer token

**Extension side:** run **Mallard: Set Webhook Bearer Token**.

Alternative to `X-API-Key`. Sent as:

```
Authorization: Bearer <token>
```

The token value is treated identically to an API key: it goes through the
same hash lookup against the `API_KEYS` store, so it must be pre-registered
there like any other key. A plain bearer token is **not** validated against an
identity provider — an OpenBao/OAuth token works only if its exact value has
been added to `API_KEYS`. To accept tokens signed by an identity provider
instead, use [JWT bearer](#jwt-bearer) below.

## JWT bearer

A `Authorization: Bearer <token>` value that looks like a JWT (three
dot-separated base64url segments) is verified as one **first**; when JWT auth
is not configured, or the token doesn't verify, it falls through to the
API-key lookup above, so existing bearer-token setups keep working.

Configure verification material with one of (all optional; empty = JWT auth
off):

| Setting | Purpose |
|---|---|
| `JWT_HMAC_SECRET` | Shared secret for `HS*` tokens |
| `JWT_PUBLIC_KEY` | PEM public key for `RS*` / `ES*` / `PS*` tokens |
| `JWT_JWKS_URL` | JWKS endpoint of your identity provider (asymmetric keys) |
| `JWT_ALGORITHMS` | Comma-separated allowed algorithms (default `HS256`, or `RS256,ES256` for asymmetric material) |
| `JWT_ISSUER` | Required `iss` claim (empty = not enforced) |
| `JWT_AUDIENCE` | Required `aud` claim (empty = not enforced) |
| `JWT_LABEL_CLAIM` | Claim that identifies the sender (default `sub`) |
| `JWT_LABELS` | `label:claimValue` pairs mapping a claim value to a `source` label |

- The accepted algorithms are derived from the configured key material, never
  from the token header, and `HS*` is accepted only when a shared secret is the
  sole material configured (no algorithm-confusion).
- Every token must carry `exp`; expired or badly signed tokens are rejected.
- The `source` tag is the `JWT_LABELS` entry for the claim value, else the
  claim value itself when it is a safe label (`[A-Za-z0-9._@-]`, at most 64
  characters), else `unknown`.
- **Always set `JWT_ISSUER` and `JWT_AUDIENCE` with `JWT_JWKS_URL`.** A JWKS
  endpoint holds the keys of an identity provider that normally signs tokens
  for many applications and tenants; without issuer and audience pinning, any
  valid unexpired token from that provider authenticates, including tokens
  issued to someone else's application. The server logs a startup warning when
  `JWT_JWKS_URL` is set without them.
- Signing keys are fetched from the JWKS and cached for five minutes; a token
  whose `kid` isn't in the set triggers at most one refetch per minute, so a
  key rotation is picked up promptly without junk tokens being able to hammer
  your identity provider.

## mTLS client certificate

**Extension settings:** `mallard.shared.certificate.file`, `mallard.shared.certificate.keyFile`

The extension presents a client certificate when establishing the TLS
connection. The certificate must be issued by the server operator using the
`mallard-ca` ClusterIssuer.

mTLS authenticates the **HTTP webhook only**. The embedded MQTT broker sits
behind the TLS-terminating proxy and never sees a client certificate, so an
MQTT connection is always authenticated by the shared broker password (see
[MQTT password](#mqtt-password)) — `mallard.mqtt.auth = "certificate"` on its
own is rejected by the server.

The `source` tag comes from the certificate's CN: if the CN has an entry in
the optional `CERT_LABELS` store (`label:cn` pairs, e.g.
`ci:build-agent-01`), that label is used; otherwise the CN itself is the
source.

**Server side:**
- The server trusts `SSL_CLIENT_S_DN_CN` **only when the proxy also sends
  `SSL_CLIENT_VERIFY: SUCCESS`**. With `verify-client optional` the proxy
  forwards the subject of an unverified (e.g. self-signed) certificate too;
  without this gate any client could pick its own CN. A missing or non-`SUCCESS`
  verify header means the certificate is ignored (the request then falls back to
  an API key / bearer token, or gets a `401`).
- nginx Ingress: `auth-tls-*` annotations forward the client subject DN as the
  `SSL_CLIENT_S_DN_CN` header (via the standard `$ssl_client_s_dn` variable)
  and `$ssl_client_verify` as `SSL_CLIENT_VERIFY`.
- Caddy (Docker Compose): mTLS is opt-in — uncomment the `client_auth` block in
  the Caddyfile. `request_header SSL_CLIENT_S_DN_CN {tls_client_subject}` is
  always set (empty without a cert), and any client-supplied
  `SSL_CLIENT_VERIFY` is stripped before Caddy sets its own, which prevents
  header spoofing.
- The server accepts either a bare CN or a full subject DN in that header and
  extracts the CN itself.

**Certificate provisioning (operator):**

```bash
# Issue a cert via cert-manager
kubectl apply -f client-cert.yaml

# Export for distribution to the user
kubectl get secret mallard-client-team-alpha-tls -n mallard \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > team-alpha.crt
kubectl get secret mallard-client-team-alpha-tls -n mallard \
  -o jsonpath='{.data.tls\.key}' | base64 -d > team-alpha.key
```

## MQTT password

**Extension side:** run **Mallard: Set MQTT Export Password** (SecretStorage).

Sent as the MQTT CONNECT `password` field over `wss://<host>/mqtt`. The server
validates it against a **single shared broker password** (`MQTT_PASSWORD` in
the secret store) and tags everything ingested over MQTT with
`source='mqtt'` — there are no per-client MQTT labels. The `username` field is
sent as broker metadata but is **not** used for identification. If you need
per-team attribution, use the webhook transport with labeled API keys.

The password is mandatory: a CONNECT without it is refused even if the client
presents a certificate (see [mTLS](#mtls-client-certificate)). The broker only
carries topics under `MQTT_TOPIC_PREFIX` (default `mallard/`): publishing,
subscribing or receiving on any other topic is denied at the broker, and
messages outside the prefix are never ingested. MQTT ingest is rate limited per
source and peer address, never per client-chosen `client_id`.

## Webhook signing (optional)

Defense-in-depth on top of any HTTP auth method: when enabled, every ingest
request must carry an HMAC-SHA256 signature of the exact request body.

- **Extension side:** run **Mallard: Set Webhook Signing Secret**. The
  extension then adds `X-Mallard-Signature-256: sha256=<hex>` to every POST.
- **Server side:** set `WEBHOOK_HMAC_SECRETS` in the secret store to one or
  more comma-separated secrets. Empty (the default) disables checking
  entirely — the feature is opt-in and backward compatible. A request with a
  missing or invalid signature is rejected with `401 Invalid signature`.
- **Rotation:** list the new secret alongside the old one
  (`new-secret,old-secret`), roll clients over to the new value, then remove
  the old entry. The server accepts a signature made with any listed secret.

The signature authenticates the request body; the API key still identifies
the sender. Signing does not replace auth — requests without valid
credentials are rejected before the signature is ever checked.

## Named credentials and the `source` tag

Every request maps to a `source` tag written on each InfluxDB data point:

| Auth method | Source of the `source` tag |
| --- | --- |
| API key | The label in `API_KEYS=label:key` |
| Bearer token | Treated as an API key: the label from the credential store |
| JWT bearer | `JWT_LABELS` entry for the `JWT_LABEL_CLAIM` value (default `sub`), else the claim value itself |
| mTLS client certificate | `CERT_LABELS` entry for the CN, else the CN itself |
| MQTT password | Always `mqtt` |
| Unlabelled key (bare secret) | `"unknown"` |

Format for API keys: `label:secret`, comma-separated for multiple identities;
`CERT_LABELS` uses `label:cn`:

```bash
# Seeded into the secret manager (see the self-hosting guide)
API_KEYS=alice:key-abc123,bob:key-def456,ci-pipeline:key-ghi789
CERT_LABELS=ci:build-agent-01
MQTT_PASSWORD=shared-broker-password
WEBHOOK_HMAC_SECRETS=
# JWT bearer (optional) — see the JWT section above
JWT_JWKS_URL=https://idp.example.com/.well-known/jwks.json
JWT_ISSUER=https://idp.example.com/
JWT_AUDIENCE=mallard
JWT_LABELS=ci:ci-bot
```

Labels are arbitrary strings: usernames, machine names, team names, whatever
fits your naming convention.

## Querying by source in Flux

```flux
// Total credits used by Alice in the last 7 days
from(bucket: "metrics")
  |> range(start: -7d)
  |> filter(fn: (r) => r["_measurement"] == "mallard_events" and r["source"] == "alice")
  |> sum()

// Compare spend across all team members in a single query
from(bucket: "metrics")
  |> range(start: -30d)
  |> filter(fn: (r) => r["_measurement"] == "mallard_events")
  |> group(columns: ["source"])
  |> sum()
```

## Per-team Grafana dashboards

The pre-built Grafana dashboards include a `source` variable that drives all panels.
Select a source from the dropdown to filter the entire dashboard to one identity. To add
a new source, add a new labelled credential. Grafana queries InfluxDB for the distinct
list of `source` values dynamically, so no dashboard edit is needed.

## Auth precedence on the server (HTTP)

1. `SSL_CLIENT_S_DN_CN` header, **only when `SSL_CLIENT_VERIFY` is `SUCCESS`** (set by the TLS terminator for a verified client cert) → `source` from `CERT_LABELS`, else the CN. An unverified cert is ignored, not rejected.
2. `Authorization: Bearer <jwt>` when the token looks like a JWT and JWT auth is configured and verifies → `source` from the claim (`JWT_LABELS`, else the claim value). A token that doesn't verify falls through to step 3.
3. `X-API-Key` header, else the `Authorization: Bearer <token>` value → `source = label from credential store`. If both are present, `X-API-Key` wins.
4. None of the above → `401 Unauthorized`

When `WEBHOOK_HMAC_SECRETS` is configured, the signature check runs after
authentication succeeds, on the raw request body.

The extension should send exactly one credential per request. Sending both a verified cert and an API key is valid (the cert takes precedence and the key is not checked), but is not necessary.

## Bare (unlabeled) keys

`API_KEYS` entries without a `label:` prefix are accepted and tagged
`source=unknown`. Use the labeled format if you want per-team InfluxDB tagging.

This covers authentication only. The ingest payload body is versioned separately via a `schema_version` field; the Metrics Schema reference page covers how old, current, and unrecognized future payload versions are all accepted.
