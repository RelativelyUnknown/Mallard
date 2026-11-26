# Configuration

Mallard works out of the box. Everything you can configure is a normal VS Code setting: open **Settings** and search for `@ext:RelativelyUnknown.mallard`, or edit `settings.json`. The **Edit alert rules** button in the dashboard opens the same Settings editor, filtered to Mallard.

There is no separate config file any more. Budgets, alerts, display preferences, currency, GitHub billing and export targets all live in your user settings, so they sync with Settings Sync like the rest of your editor setup.

## Where each setting lives

| What | Setting | Scope |
| --- | --- | --- |
| Budget and alert thresholds | `mallard.monthlyBudget`, `mallard.includedCredits`, `mallard.dailyCreditAlert`, `mallard.alerts.*`, `mallard.branchBudgets` | user (synced) |
| Custom threshold alerts | `mallard.alerts.rules` | user (synced) |
| Dashboard display | `mallard.display.*`, `mallard.palette`, `mallard.currency` | user (synced) |
| Refresh, retention, connectors | `mallard.refreshIntervalMinutes`, `mallard.dataRetentionDays`, `mallard.enabledConnectors` | user (synced) |
| GitHub billing | `mallard.githubBilling.mode`, `mallard.githubBilling.org` | user (synced) |
| Export server, transport, targets, certificates | `mallard.server.url`, `mallard.export.*`, `mallard.webhook.auth`, `mallard.mqtt.*`, `mallard.shared.certificate.*` | this machine only |
| Pricing feed override, Copilot telemetry path | `mallard.pricingManifestUrl`, `mallard.copilotOtelPath` | this machine only |
| Passwords, API keys, tokens | VS Code SecretStorage (your OS keychain), via the **Mallard: Manage Credentials** command | never in settings |
| Dashboard layout (panel order, size, hidden panels) | VS Code extension storage, edited in the dashboard | this machine |

"This machine only" settings are never synced, and a workspace's `.vscode/settings.json` can never set them, so an opened project cannot redirect your usage data. The full list, with types, defaults and ranges, is in the [Settings reference](../reference/settings.md).

Mallard validates every value itself, because VS Code does not: a number outside its range is clamped, an unknown choice falls back to the default, and in a list (alert rules, export targets) one bad entry is ignored, with a note in the **Mallard** Output panel, without affecting the entries next to it.

## Budget and alerts

```json
{
  "mallard.monthlyBudget": 20,
  "mallard.includedCredits": 300,
  "mallard.dailyCreditAlert": 50,
  "mallard.alerts.velocityEnabled": true,
  "mallard.alerts.velocityCreditsPerHour": 100,
  "mallard.branchBudgets": { "main": 500, "feature/billing": 120 }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `mallard.monthlyBudget` | 0 | USD budget; 0 disables budget alerts. |
| `mallard.includedCredits` | 300 | Plan's monthly premium-request allowance; colours the gauge. |
| `mallard.dailyCreditAlert` | 50 | Daily credit threshold; 0 disables it. |
| `mallard.alerts.velocityEnabled` | true | Enable the spending-velocity alert. |
| `mallard.alerts.velocityCreditsPerHour` | 100 | Credits/hour rate that triggers it. |
| `mallard.branchBudgets` | `{}` | Per-branch credit caps. |

`mallard.alerts.rules` holds your own threshold alerts as an array of objects; it shows **Edit in settings.json** in the Settings editor. Each rule compares one metric with a number:

```json
"mallard.alerts.rules": [
  { "id": "big-day", "metric": "today.credits", "op": ">", "value": 200, "cooldown": "6h", "severity": "warning" }
]
```

The fixed list of metrics, the operators, cooldowns, `restrict` and `clearBelow` are in the [alert rules reference](../reference/alert-rules.md). The scalar settings above are the built-in alerts (budget at 80 % and 100 %, daily credits, velocity, branch caps); alert cooldowns are remembered across reloads.

## Moving from `config.json`

Earlier versions kept these settings in `config.json` inside Mallard's storage folder. On the first start after upgrading, Mallard imports that file once:

- budgets, alert thresholds, branch budgets, display preferences, currency, GitHub billing and export targets become the matching settings;
- the dashboard layout is copied into extension storage (unless you already have one);
- export targets get a stable `id` (the old target name when it can serve as one, so stored credentials keep working; otherwise a generated id, and the credentials are moved to it);
- the file is renamed to `config.json.migrated`, never deleted, and a single message tells you what moved.

Your **custom alert rules** are converted too, in a second step: the rules a flat rule can express are appended to `mallard.alerts.rules` (nothing is duplicated if it runs twice) and one message says how many were converted and how many were not. Rules that need the old rules language (combined conditions, groups, variables, `requiresAuth`, `in`/`matches` and the like) are listed with their reason in the **Mallard** output channel and stay in `config.json.migrated`; recreate the ones you still need as flat rules. [What converts and what does not](../reference/alert-rules.md#legacy) is in the reference.

If `config.json` cannot be read (for example it is not valid JSON), Mallard leaves it untouched, warns once, and tries again on the next start once you have fixed it. **Mallard: Prepare for Uninstall** removes `config.json` and its `.migrated` backup along with everything else.

## Restriction popups

A rule with `"restrict": true` shows a popup while it matches, and `clearBelow` lifts it once the metric has dropped below a number (see the [alert rules reference](../reference/alert-rules.md#restrictions)).

The popup offers **Dismiss**, **Snooze 15m**, **Snooze 1h**, and **Disable Mallard...**. Mallard never disables any extension automatically; **Disable Mallard...** opens the Extensions view filtered to Mallard so you can turn it off yourself in one click.

## Dashboard layout

Use **Edit layout** in the dashboard to drag, resize, or hide panels, and **Add chart** to bring in the optional extra charts (by repository, cost categories over time, tokens over time, GitHub billing items). Every change is saved automatically into VS Code's `globalState` for the extension (key `mallard.layout.v2`), so it survives restarts but is not hand-editable and is not a setting. **Reset layout** restores defaults; **Mallard: Prepare for Uninstall** clears it. See [Features](./features.md#layout) for the keyboard controls.

A layout saved by an earlier version (the older `dashboard.panels` block of `config.json` or the previous `globalState` layout) is migrated automatically the first time the dashboard opens. The grid is always four columns wide, so the old `dashboard.columns` option and the `gridColumn` / `gridRow` panel fields are no longer read.

## Display currency

The currency selector in the dashboard header writes `mallard.currency` (e.g. `"mallard.currency": "EUR"`); you can also set it in Settings. Exchange rates are fetched daily from Frankfurter; metric exports always use USD regardless.
