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

`mallard.alerts.rules` holds your own threshold alerts as an array of objects; it shows **Edit in settings.json** in the Settings editor. The rules reference is being rewritten for this format and is covered separately.

## Moving from `config.json`

Earlier versions kept these settings in `config.json` inside Mallard's storage folder. On the first start after upgrading, Mallard imports that file once:

- budgets, alert thresholds, branch budgets, display preferences, currency, GitHub billing and export targets become the matching settings;
- the dashboard layout is copied into extension storage (unless you already have one);
- export targets get a stable `id` (the old target name when it can serve as one, so stored credentials keep working; otherwise a generated id, and the credentials are moved to it);
- the file is renamed to `config.json.migrated`, never deleted, and a single message tells you what moved.

What it cannot convert is your **custom alert rules, rule groups and variables**: that rules language was replaced by the flat `mallard.alerts.rules` list. They stay in `config.json.migrated`, and the import message says how many there were. Recreate the ones you still need as flat rules.

If `config.json` cannot be read (for example it is not valid JSON), Mallard leaves it untouched, warns once, and tries again on the next start once you have fixed it. **Mallard: Prepare for Uninstall** removes `config.json` and its `.migrated` backup along with everything else.

## Restriction popups

A rule that is configured to restrict shows a popup when it fires; the old `restrict` block of the rules language is part of what the flat rules replace, so restriction rules follow the same migration as the rest of the custom rules above.

The popup offers **Dismiss**, **Snooze 15m**, **Snooze 1h**, and **Disable Mallard...**. Mallard never disables any extension automatically; **Disable Mallard...** opens the Extensions view filtered to Mallard so you can turn it off yourself in one click.

## Dashboard layout

Use the **Resize** and **Move** buttons to drag, resize, or hide panels, and **Add chart** to bring in the optional extra charts (by repository, cost categories over time, tokens over time, GitHub billing items). The layout is saved automatically in VS Code's extension storage, per machine; it is not a setting. **Reset layout** restores defaults.

## Display currency

The currency selector in the dashboard header writes `mallard.currency` (e.g. `"mallard.currency": "EUR"`); you can also set it in Settings. Exchange rates are fetched daily from Frankfurter; metric exports always use USD regardless.
