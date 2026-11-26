# Settings Reference

Everything Mallard can be configured with is an ordinary VS Code setting. Open
**Settings** and search for `@ext:RelativelyUnknown.mallard`, or edit
`settings.json` directly. The dashboard's **Edit alert rules** button and the
currency selector write the same settings. There is no separate config file any
more: a `config.json` from an earlier version is imported once, on first start
(see the [Configuration guide](../guide/configuration.md)).

Each setting has a scope that decides where it can be set:

| Scope | Meaning |
|-------|---------|
| `application` | User level. Synced by Settings Sync; a workspace's `.vscode/settings.json` can never set it. |
| `machine` | This machine only. Never synced, and a workspace can never set it, so an opened project cannot redirect your usage data or credentials to another server. |
| `machine-overridable` | Like `machine`, but a workspace may override it. Ignored in an untrusted workspace. |

VS Code does not validate setting values when it reads them. Mallard does: a
value that is out of range or of the wrong type is replaced by the default (a
number is clamped into its range), and one bad entry in an array setting is
ignored and noted once in the **Mallard** output channel, without affecting the
entries next to it. Settings that hold arrays or objects (`alerts.rules`,
`branchBudgets`, the export targets) show **Edit in settings.json** in the
Settings UI; they are written back as a whole.

<!--
  The tables below are generated from src/extension-backend/config/settings.ts.
  Edit the table there (and the matching property in package.json), then run
  `bun run docs:settings`. Do not edit between the BEGIN/END markers.
-->

## Budgets and alerts

<!-- BEGIN settings:Budgets and alerts -->
| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `mallard.monthlyBudget` | `number`, 0–1000000 | `0` | `application` | Monthly budget in USD. 0 disables budget tracking and the budget alerts. |
| `mallard.includedCredits` | `number`, 0–1000000 | `300` | `application` | Premium requests included in your Copilot plan each month. Colours the spend gauge and drives the "% of included" alerts. |
| `mallard.dailyCreditAlert` | `number`, 0–1000000 | `50` | `application` | Warn once a day when the day's credits exceed this. 0 disables the alert. |
| `mallard.alerts.velocityEnabled` | `boolean` | `true` | `application` | Warn when credits are being spent faster than the velocity threshold. |
| `mallard.alerts.velocityCreditsPerHour` | `number`, 0–1000000 | `100` | `application` | Credits per hour above which the velocity alert fires. 0 disables it. |
| `mallard.alerts.rules` | `object[]` | `[]` | `application` | Custom threshold alerts: each rule compares one metric with a value, e.g. { "id": "big-day", "metric": "today.credits", "op": ">", "value": 200, "cooldown": "6h", "severity": "warning" }. Edit in settings.json. |
| `mallard.branchBudgets` | `object` | `{}` | `application` | Per-branch credit caps keyed by branch name, e.g. { "main": 500, "feature/x": 120 }. A branch over its cap raises an alert. |
<!-- END settings:Budgets and alerts -->

Budgets are in USD, credits are Copilot premium requests. A branch listed in
`mallard.branchBudgets` raises an alert once its credits pass the cap; it is
written whole, so keep the other branches when you change one:

```json
"mallard.monthlyBudget": 20,
"mallard.includedCredits": 300,
"mallard.dailyCreditAlert": 50,
"mallard.alerts.velocityCreditsPerHour": 100,
"mallard.branchBudgets": { "main": 500, "feature/billing": 120 }
```

## Dashboard

<!-- BEGIN settings:Dashboard -->
| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `mallard.currency` | `string` | `"USD"` | `application` | Display currency as an ISO 4217 code (e.g. EUR). Costs are converted from USD with daily exchange rates; metric exports always use USD. Also set by the dashboard's currency selector. |
| `mallard.palette` | `"swiss" \| "theme"` | `"swiss"` | `application` | Dashboard chart palette. Both modes keep the duotone structure and are checked for accessibility. |
| `mallard.display.dailyBarsWindow` | `integer`, 7–90 | `30` | `application` | Days shown in the daily bars, cumulative area and token charts. |
| `mallard.display.heatmapWeeks` | `integer`, 4–52 | `52` | `application` | Weeks shown in the activity heatmap (52 is a full year). |
| `mallard.display.topN` | `integer`, 3–20 | `8` | `application` | How many models and repositories to show in ranked lists. |
<!-- END settings:Dashboard -->

The dashboard layout (which panels, their order and size) is not a setting: it is
saved by the dashboard itself in VS Code's extension storage, per machine.

## Data sources

<!-- BEGIN settings:Data sources -->
| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `mallard.enabledConnectors` | `("copilot" \| "claude-code")[]` | `["copilot","claude-code"]` | `application` | Which usage connectors Mallard ingests from. Set by the onboarding flow when both Copilot and Claude Code are installed (run "Mallard: Show Onboarding" to redo it). Changing this requires reloading the window. Applies after a window reload. |
| `mallard.copilotOtelPath` | `string` | `""` | `machine-overridable` | Override path to Copilot's OpenTelemetry export target: a JSONL file, or a .sqlite/.db database. Blank auto-detects it from github.copilot.chat.otel.outfile. Run "Mallard: Enable Copilot Usage Tracking" to set it up automatically. |
| `mallard.pricingManifestUrl` | `string` | `""` | `machine` | Override URL for the pricing manifest JSON. Blank uses the auto-refreshed default. Applies without a reload. |
| `mallard.refreshIntervalMinutes` | `number`, 1–60 | `10` | `application` | How often Mallard re-reads logs and recomputes the snapshot, in minutes. Lower values update the dashboard sooner at the cost of CPU. |
| `mallard.dataRetentionDays` | `number`, 30–365 | `90` | `application` | Days of raw per-request events to keep before they are rolled up into daily totals. Higher values use more disk. Changing this requires reloading the window. Applies after a window reload. |
<!-- END settings:Data sources -->

## GitHub billing

<!-- BEGIN settings:GitHub billing -->
| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `mallard.githubBilling.mode` | `"vscode-session" \| "pat"` | `"vscode-session"` | `application` | How Mallard authenticates for GitHub billing data. |
| `mallard.githubBilling.org` | `string` | `""` | `application` | GitHub organization slug for org-level Copilot billing (needs read:org). Blank shows your personal billing. |
<!-- END settings:GitHub billing -->

The personal access token itself is never a setting: it lives in SecretStorage
(**Mallard: Set GitHub Personal Access Token**).

## Metric export settings

Mallard can stream a usage feature vector to a self-hosted server after every snapshot.
Every export setting (and `mallard.pricingManifestUrl`) is `machine` scoped. Transport,
auth, URL, certificate and target changes apply immediately: the exporter is rebuilt in
place.

<!-- BEGIN settings:Metric export -->
| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `mallard.server.url` | `string` | `""` | `machine` | Base URL of your self-hosted Mallard server (e.g. https://mallard.example.com). Used as the webhook endpoint and as the fallback MQTT WebSocket host. |
| `mallard.export.transport` | `"" \| "webhook" \| "mqtt"` | `""` | `machine` | Transport used for metric export. Set mallard.server.url first. Leave blank to disable. |
| `mallard.export.webhookTargets` | `object[]` | `[]` | `machine` | Extra webhook servers that mirror every payload when the transport is "webhook", as { "id", "name", "url" }. Each target's credentials are stored under its id (see "Mallard: Configure Export Fanout Targets"). Ids must be unique across webhook and MQTT targets. Edit in settings.json. |
| `mallard.export.mqttTargets` | `object[]` | `[]` | `machine` | Extra MQTT brokers that mirror every payload when the transport is "mqtt", as { "id", "name", "url" } with a wss:// URL. Each broker's password is stored under its id. Ids must be unique across webhook and MQTT targets. Edit in settings.json. |
| `mallard.webhook.auth` | `"apiKey" \| "bearer" \| "certificate"` | `"apiKey"` | `machine` | Auth method for the webhook transport. Credentials are kept in SecretStorage via the Mallard credential commands, never in settings. |
| `mallard.mqtt.url` | `string` | `""` | `machine` | MQTT broker WebSocket URL (e.g. wss://mallard.example.com/mqtt). Overrides mallard.server.url for MQTT. Only TLS URLs are accepted. |
| `mallard.mqtt.username` | `string` | `""` | `machine` | MQTT username, sent in the CONNECT packet as broker metadata. The Mallard server identifies you by the shared broker password; the username is not used for identification. |
| `mallard.shared.certificate.file` | `string` | `""` | `machine` | Path to the PEM client certificate file. Used when the webhook auth is "certificate". |
| `mallard.shared.certificate.keyFile` | `string` | `""` | `machine` | Path to the PEM private key file paired with mallard.shared.certificate.file. |
| `mallard.shared.certificate.caFile` | `string` | `""` | `machine` | Path to a CA bundle PEM file used to verify the server's TLS certificate. |
<!-- END settings:Metric export -->

### Webhook auth

Active when `mallard.export.transport = "webhook"`. The credential itself is
stored in SecretStorage, never in settings — run **Mallard: Set Webhook API
Key** or **Mallard: Set Webhook Bearer Token** (or **Mallard: Manage
Credentials**) from the Command Palette.

### MQTT

Active when `mallard.export.transport = "mqtt"`. Only TLS URLs are accepted — `wss://` or `mqtts://`; plain `mqtt://` and `ws://` are rejected. The bundled server broker is reached over `wss://<host>/mqtt`. It authenticates by the shared broker password only (it sits behind a TLS-terminating proxy and never sees a client certificate); for mTLS against the server, use the webhook transport.

Run **Mallard: Set MQTT Export Password** from the Command Palette to store the password securely in VS Code's SecretStorage (never written to settings files).

### Payload schema

Each publish sends a single JSON batch of usage events, built by `buildStreamBatch`. Over MQTT it is published to `mallard/v1/<machineHash>[/<workspaceHash>]`, which the server broker accepts because it lies under its `MQTT_TOPIC_PREFIX` (default `mallard/`). The extension sends `schema_version: 1`. The Metrics Schema reference page has the full field table, aggregation semantics, and how the server handles a schema version it doesn't recognize yet.

### Webhook example (API key)

```json
"mallard.server.url": "https://your-server",
"mallard.export.transport": "webhook",
"mallard.webhook.auth": "apiKey"
```

Then run **Mallard: Set Webhook API Key** from the Command Palette to store the
key securely. (The key's *label* — which team/person it belongs to — is
configured server-side in the secret manager, not in the key value you enter.)

### Multiple webhook servers

The webhook transport can mirror every payload to additional servers (e.g. a
personal and a team endpoint). Run **Mallard: Configure Export Fanout
Targets** from the Command Palette to add, remove, and set credentials for
targets — changes apply immediately, no reload needed. Targets are stored in the
`mallard.export.webhookTargets` setting and can also be declared by hand:

```json
"mallard.export.webhookTargets": [
  { "id": "team", "name": "Team server", "url": "https://mallard.team.example.com" }
]
```

Each target authenticates with its own credentials, stored under its `id` —
set them via **Mallard: Manage Credentials**, where each target shows
up as its own API key / bearer token / signing secret slot. Keep the `id` stable
(only `name` is a free label): changing it leaves the old credentials behind and
the new id with none. Ids are 1–32 letters, digits, dots, underscores or dashes,
and must be unique across the webhook and MQTT lists. The auth method
(`mallard.webhook.auth`) and any mTLS certificate paths are shared across all
targets. A payload is queued for retry only while every failing target is
retryable; a target that rejects with a 4xx (bad credential) fails the batch
fatally so the queue can't spin forever.

The MQTT transport mirrors the same way with `mallard.export.mqttTargets` (each
broker gets its own CONNECT password slot in **Manage Credentials**; the
username and any certificate paths are shared):

```json
"mallard.export.mqttTargets": [
  { "id": "team-broker", "name": "Team broker", "url": "wss://mallard.team.example.com/mqtt" }
]
```

### MQTT example (password)

```json
"mallard.server.url": "https://your-server",
"mallard.export.transport": "mqtt",
"mallard.mqtt.username": "alice"
```

Then run **Mallard: Set MQTT Export Password** from the Command Palette.

### Webhook example (mTLS)

```json
"mallard.server.url": "https://your-server",
"mallard.export.transport": "webhook",
"mallard.webhook.auth": "certificate",
"mallard.shared.certificate.file": "/home/you/.certs/client.crt",
"mallard.shared.certificate.keyFile": "/home/you/.certs/client.key",
"mallard.shared.certificate.caFile": "/home/you/.certs/ca.crt"
```
