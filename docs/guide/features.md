# Features

Mallard is a local-first spend tracker for GitHub Copilot and Claude Code. No sign-in is needed for anything except GitHub billing reconciliation; all other features run entirely offline.

## Data sources

Mallard reads whichever local usage logs are present: Copilot's OTel logs and Claude Code's JSONL session logs. Both are tracked automatically and simultaneously if both tools are installed and used; each event is tagged with its source connector, so the dashboard, alert rules, and exports can all break spend down by tool as well as by model, surface, and repo.

## Dashboard

Open from the activity bar icon or **Mallard: Open Dashboard**. The dashboard shows:

- **KPI cards**: today, month-to-date, projected month-end, and top model
- **Spend gauge**: credits used against your included allowance, with severity colouring at 80% and 100% of budget
- **30-day bar chart**: daily spend with a projected-pace line and previous-period comparison bars
- **Model breakdown**: top models by credits
- **Sankey flow chart**: credits from each model to each surface (chat, inline, agent, edit)
- **Cost-type chart**: input vs output token spend (plus cache and thinking categories for Claude Code sessions). Categories with no attributed spend are hidden — a reserved `tool` category exists in the schema but no local log source produces it yet.

A pop-out button opens the same view as a full editor tab.

## Extra charts

Four more charts sit behind the **Add chart** button, hidden until you want them:

- **By repository** — spend per repo. Repos whose spend is partly attributed by the active-editor heuristic (see below) are marked with `≈`.
- **Cost categories over time** — a stacked view of input/output/cache/thinking/tool cost per day, showing how the mix shifts.
- **Tokens over time** — daily token volume, with request counts in the tooltip.
- **GitHub billing items** — net amount per model/SKU from the billing API (needs sign-in).
- **≈ By language** — spend per programming language, detected from the active editor the same way the repo heuristic works (live events only, never backfill). The `≈` in the title is deliberate: treat it as directional.

Added charts behave like the stock ones: drag, resize and hide them like any other panel.

## Layout

The analysis charts sit on a freeform grid (four columns wide). Press **Edit layout** to change it, and **Edit layout** again when you are done. While editing:

- **Mouse or touch**: drag a panel by its header to move it, and drag its edge or bottom-right corner to resize it. Panels never overlap; neighbours make room.
- **Hide**: the eye button on a panel's header removes it from the grid. **Add chart** lists hidden panels and brings one back.
- **Reset layout** restores the default arrangement.

Your arrangement is saved automatically in VS Code's own storage for the extension (not in the settings) and survives restarts. In a narrow window (700 px or less) the grid collapses to one column; editing is switched off there, and your wide layout is left untouched.

### Moving and resizing with the keyboard

Every panel has a **move handle** (a grip button in its header) that is reachable with Tab while editing. A screen reader announces each step.

| Key | Does |
| --- | --- |
| `Space` or `Enter` on the move handle | **Lift** the panel |
| Arrow keys | Move the lifted panel one column left or right, or past the nearest panel above or below |
| `R` | Switch between moving and **resizing** |
| Arrow keys while resizing | `Right` / `Left` make it one column wider / narrower; `Down` / `Up` make it one height step taller / shorter (compact, normal, tall) |
| `Space` or `Enter` | **Drop** the panel where it is, saving the change |
| `Escape` | **Cancel**: every panel goes back to where it was when you lifted |

Moving focus away from the move handle drops the panel. Announcements give the column and an ordinal row band (for example "Models moved to column 3, row band 1"), and name any panel that had to make room.

## Budget and alerts

Set a monthly budget, included-credit allowance, daily threshold, and velocity alert in VS Code Settings (click **Edit alert rules** to open them):

```json
"mallard.monthlyBudget": 20,
"mallard.includedCredits": 300,
"mallard.dailyCreditAlert": 50,
"mallard.alerts.velocityEnabled": true,
"mallard.alerts.velocityCreditsPerHour": 40
```

## Custom alert rules

Add your own threshold alerts to the `mallard.alerts.rules` setting. A rule compares one metric (today's, this month's or the forecast's credits and cost, the budget percentage, the spending rate, the last 7 days, the current branch, or one model or repository) with a number, and has a cooldown that is remembered across reloads:

```json
"mallard.alerts.rules": [
  { "id": "big-day", "metric": "today.credits", "op": ">", "value": 100, "cooldown": "2h", "severity": "warning" }
]
```

The notification text is fixed: `today.credits > 100 (now 113)`. See the [alert rules reference](../reference/alert-rules.md) for every metric, the built-in alerts and how your old `config.json` rules were converted.

## Restriction popups

Add `"restrict": true` to a rule to show a popup while its condition holds. No extensions are disabled; the popup creates friction. `clearBelow` keeps the restriction until the metric has dropped below a number:

```json
{ "id": "budget-exhausted", "metric": "budget.percentOfBudget", "op": ">=", "value": 1, "cooldown": "4h", "severity": "critical", "restrict": true, "clearBelow": 0.9 }
```

The popup shows Dismiss, Snooze 15m, Snooze 1h, and Disable Mallard... buttons. Disable Mallard... opens the Extensions view so you can turn Mallard off yourself; it is a manual step, never an automatic one. Restrictions on `velocity.creditsPerHour` work too: they read the same recent-spend history as the velocity alert.

Run **Mallard: Simulate Restriction State** from the Command Palette for a dry run. It reports what would happen without disabling anything.

## Branch-aware tracking

Every event is tagged to the active git branch and repo. Set per-branch credit caps in the `mallard.branchBudgets` setting:

```json
"mallard.branchBudgets": { "feature/big-refactor": 500, "main": 200 }
```

When a branch hits its cap, Mallard shows a warning notification (4-hour cooldown). Custom rules can use the `currentBranchCredits` metric.

## Per-repo filtering and attribution

A dropdown in the dashboard filters all charts and KPIs to a single repo. How an event gets its repo depends on what the source log records:

| Attribution | Meaning |
|---|---|
| **Authoritative** | The log line itself names the workspace. Claude Code records the session's working directory per line, so its events are attributed reliably — even when old sessions are ingested later. |
| **Heuristic** (`≈`) | Copilot's logs carry no workspace path, so live events are attributed to the repo of the active editor at parse time — usually right, but a guess. Repos with heuristic spend are marked `≈` in the dropdown and the repository chart. |
| **Unattributed** | No trustworthy signal. Historical events found during a backfill (first install, or **Rebuild Ingested Data**) are never attributed by the heuristic — the usage happened before the current editor state existed, so guessing would silently blame the wrong repo. They land in the `unattributed` bucket instead. |

An event's attribution is fixed when it is first stored and never silently relabeled by a later re-read.

## GitHub billing reconciliation

Run **Mallard: Sign In to GitHub** to pull the authoritative Copilot charge from GitHub's billing API: spend across all your machines, not just the current one. Sign-in is optional; all other features work without it.

This is Copilot-specific and stays that way: GitHub exposes a user-scoped billing API an individual can authenticate against with their own account. Anthropic's usage/cost API is organization-admin-scoped, not something an individual Claude Code user can call the way they call GitHub's. Claude Code spend is always local-log-based (estimated), the same way Copilot spend is before you sign in.

## Event streaming

Mallard can stream usage events to a self-hosted server via webhook or MQTT — set `mallard.server.url` and `mallard.export.transport`. Every batch of freshly ingested events is priced and labeled on-device and published as finished records (model, surface, connector, credits, USD cost, tokens, repo, branch, detected language); the server just stores them, one InfluxDB point per event, and Grafana derives the aggregates. Failed sends queue durably and re-deliver in order. Credential-label attribution (API key / cert CN / JWT claim) happens only on the server. See the Metrics Schema reference for the wire format.

## Export

**Mallard: Export Monthly Report** saves a standalone, printable HTML file. No external requests; prints to PDF from any browser.

**Mallard: Export Usage Data** exports the raw event log as CSV or JSON, one row per event with timestamp, model, surface, source, credits, cost, tokens, repo, and branch.

## Automatic pricing

Credit multipliers ship with the extension and refresh daily from a validated URL. The bundled copy is the fallback when the network is unavailable. Override with `mallard.pricingManifestUrl` for a custom plan.
