# Alert Rules Reference

Custom alerts are a flat list in the `mallard.alerts.rules` setting. Each rule compares **one metric** with **one number**; there are no expressions, groups, variables or message templates. Edit the list in `settings.json` (the Settings editor shows **Edit in settings.json** for it, and the dashboard's **Edit alert rules** button opens the alert settings).

```jsonc
"mallard.alerts.rules": [
  {
    "id": "big-day",
    "metric": "today.credits",
    "op": ">",
    "value": 200,
    "cooldown": "6h",
    "severity": "warning"
  }
]
```

Mallard validates the list as you type: a rule with a mistake is skipped and reported once in the **Mallard** output channel, and the rest of the list keeps working.

## Rule fields

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Unique identifier of the rule. Cooldowns are remembered under it; a repeated id is dropped. |
| `metric` | yes | What to compare. See [Metrics](#metrics). |
| `op` | yes | `>` `>=` `<` `<=` `==` or `!=`. |
| `value` | yes | The number the metric is compared with. |
| `cooldown` | yes | Minimum time between two notifications: a positive number plus `m`, `h`, `d` or `w` (`"30m"`, `"1.5h"`, `"2d"`, `"1w"`). See [Cooldowns](#cooldowns). |
| `severity` | yes | `"info"`, `"warning"` or `"critical"`. See [Severity](#severity). |
| `notify` | no | `false` runs the rule silently (no toast), for example a rule that only exists to `restrict`. Default `true`. |
| `restrict` | no | `true` raises the restriction popup while the rule matches. See [Restrictions](#restrictions). |
| `clearBelow` | no | With `restrict`: lift the restriction once the metric is below this number. See [Restrictions](#restrictions). |

Other keys are not allowed in the settings editor's schema and are ignored.

## Metrics {#metrics}

Credits are Copilot premium-request credits (Claude Code usage is weighted the same way); costs are in your display currency. Percentages are fractions: `0.8` is 80 %.

| Metric | Unit | What it is |
| --- | --- | --- |
| `today.credits` / `today.cost` | credits / currency | Usage today (local day). |
| `month.credits` / `month.cost` | credits / currency | Month-to-date usage. |
| `budget.percentOfBudget` | fraction | Month-to-date cost as a fraction of `mallard.monthlyBudget`. `0` without a budget. |
| `budget.percentOfIncluded` | fraction | Month-to-date credits as a fraction of `mallard.includedCredits`. |
| `forecast.projectedCredits` / `forecast.projectedCost` | credits / currency | The month-end projection. |
| `velocity.creditsPerHour` | credits per hour | The recent spending rate: a least-squares fit of today's credits over the last hour of snapshots. When the daily counter drops (midnight, or a data recompute) the window restarts there, so the rate is `0` until two samples exist after the restart. |
| `window7d.credits` | credits | The last 7 calendar days, today included. Unavailable until the dashboard has daily totals. |
| `currentBranchCredits` | credits | Credits attributed to the git branch that is active right now. |
| `model:<id>.credits` / `model:<id>.cost` | credits / currency | Usage of one model, e.g. `model:gpt-4.1.credits`. The id is written as it appears in the dashboard (dots are fine). |
| `repo:<name>.credits` / `repo:<name>.cost` | credits / currency | Usage of one repository, e.g. `repo:my-app.cost`. |

Rules are evaluated against the **unfiltered** snapshot, never against a dashboard filter, so a filter cannot make an alert fire or stay quiet.

A metric that is unavailable (no data yet, no daily totals for `window7d.credits`, a model or repository that has no data at all) never satisfies a comparison, with one exception: `!=` is true, because an unknown value is not equal to anything. A model or repository that is known but has spent nothing reads `0`.

## Notifications

A notification is a warning toast with a fixed text: `<metric> <op> <value> (now <current>)`, for example `today.credits > 200 (now 213)`. `now` shows an integer as it is and anything else with two decimals.

### Severity {#severity}

`severity` is part of the rule and decides which rule of an [escalation ladder](#ladders) is shown. Every toast is shown as a warning notification; `critical` does not change how it looks.

### Cooldowns {#cooldowns}

A rule can notify again only once **more than** its `cooldown` has passed since it last did (exactly the cooldown is still blocked). Rules about a calendar period also start over with the period: a rule on `today.*` notifies again on the first snapshot of a new local day, and a rule on `month.*`, `budget.*` or `forecast.*` on the first snapshot of a new month, whatever its cooldown.

The cooldowns are saved in extension storage, so reloading the window does not repeat every alert that is still active. Entries are forgotten as soon as their own cooldown has passed (and **Mallard: Prepare for Uninstall** removes them with everything else).

### Ladders {#ladders}

Rules whose ids end in `:<number>` with the same prefix (`month:1`, `month:2`, `month:3`) form an escalation ladder: when several of them match at once only the highest severity one is considered (the first on a tie), so crossing 300 credits notifies "over 300" and not also "over 200". Silent (`notify: false`) and `restrict` rules never join a ladder. The two built-in budget alerts are such a pair.

## Built-in alerts

The scalar settings are the built-in alerts, and they are evaluated as flat rules in front of yours:

| Setting | Built-in rule | Cooldown | Severity |
| --- | --- | --- | --- |
| `mallard.monthlyBudget` above 0 | `builtin:budget:80`: `budget.percentOfBudget >= 0.8` | 4 h | warning |
| | `builtin:budget:100`: `budget.percentOfBudget >= 1` | 4 h | critical |
| `mallard.dailyCreditAlert` above 0 | `builtin:daily`: `today.credits >= <setting>` | 24 h | warning |
| `mallard.alerts.velocityEnabled` and `velocityCreditsPerHour` above 0 | `builtin:velocity`: `velocity.creditsPerHour >= <setting>` | 1 h | warning |
| `mallard.branchBudgets` entry for the current branch | `builtin:branch:<branch>`: `currentBranchCredits >= <cap>` | 4 h | warning |

Between 80 % and 100 % of the budget you get the 80 % toast, at or over 100 % only the "exceeded" one. `mallard.includedCredits` only colours the gauge. The velocity alert and `velocity.creditsPerHour` in your own rules are the same number.

## Restrictions {#restrictions}

A rule with `"restrict": true` shows a popup with **Dismiss**, **Snooze 15m**, **Snooze 1h** and **Disable Mallard...** while it matches (plus the banner on the dashboard and the status bar). Restrictions are notification-level only: Mallard never disables Copilot or any extension and does not enforce anything. **Disable Mallard...** opens the Extensions view so you can do it yourself in one click. A restriction rule shows the popup instead of a toast.

- The **first** matching `restrict` rule in the list wins. The popup and banner name its condition (for example `today.credits > 150`), not a changing value, so it opens once per restriction.
- Without `clearBelow` the restriction ends as soon as the rule stops matching.
- With `clearBelow` it **holds** after the rule stops matching until the metric is below that number, and a rule whose metric is already below it does not start a restriction at all, so it cannot flap around the threshold.
- A rule that is removed or no longer restricts ends its restriction at once. While the metric is unavailable a held restriction with `clearBelow` stays.
- Snoozing keeps the restriction underneath and hides it; the popup comes back when the snooze ends.
- Restriction rules read the same velocity history as the alerts, so a `velocity.creditsPerHour` rule restricts.

**Mallard: Simulate Restriction State** reports what the rules would do right now without applying anything.

## Examples

```jsonc
{
  "mallard.alerts.rules": [
    // Warn once a day, quietly escalating
    { "id": "week", "metric": "window7d.credits", "op": ">", "value": 800, "cooldown": "1d", "severity": "info" },

    // One model is eating the budget
    { "id": "opus-heavy", "metric": "model:claude-opus-4-5.cost", "op": ">", "value": 40, "cooldown": "12h", "severity": "warning" },

    // A repository with a spending cap
    { "id": "app-cap", "metric": "repo:my-app.credits", "op": ">=", "value": 500, "cooldown": "1d", "severity": "warning" },

    // A month that is heading over budget
    { "id": "forecast", "metric": "forecast.projectedCost", "op": ">", "value": 120, "cooldown": "1d", "severity": "warning" },

    // Show the restriction popup over 250 credits a day, lift it once the day is back under 100
    { "id": "stop-250", "metric": "today.credits", "op": ">", "value": 250, "cooldown": "1h", "severity": "critical", "restrict": true, "clearBelow": 100 },

    // A runaway agent: restrict while the rate is high, without a toast
    { "id": "runaway", "metric": "velocity.creditsPerHour", "op": ">", "value": 300, "cooldown": "30m", "severity": "critical", "restrict": true, "notify": false }
  ]
}
```

A ladder of three levels, one toast per band:

```jsonc
"mallard.alerts.rules": [
  { "id": "month:1", "metric": "month.credits", "op": ">", "value": 200, "cooldown": "45m", "severity": "info" },
  { "id": "month:2", "metric": "month.credits", "op": ">", "value": 260, "cooldown": "45m", "severity": "warning" },
  { "id": "month:3", "metric": "month.credits", "op": ">", "value": 300, "cooldown": "45m", "severity": "critical" }
]
```

## Rules from an older `config.json` {#legacy}

Earlier versions kept alerts in `config.json`, in a JSON rules language with conditions, groups, variables and message templates. On the first start after updating, Mallard converts what a flat rule can express, **appends** the result to `mallard.alerts.rules` (a rule whose id is already there is left alone, so it never duplicates) and shows one message: *Converted N alert rules to the new format; M could not be converted (reasons are in the output channel; the original is kept in config.json.migrated)*. The original is never deleted.

| Converted | How |
| --- | --- |
| A rule with one condition (`when` with a single comparison of a variable and a number, or `conditions` with one entry) | One rule. `severity`, `cooldown`, `notify` carry over; a missing cooldown becomes `1h`. |
| `thresholds` | One rule per level, `<id>:1`, `<id>:2`, ... with the level's own severity and cooldown. They form a [ladder](#ladders), so only the highest matching level notifies, as before. |
| `restrict` | `restrict: true`. A `reEnableWhen` of the form "the same variable `<` (or `<=`) a number" becomes `clearBelow`. |

| Variable | Metric |
| --- | --- |
| `today.credits`, `today.cost`, `month.credits`, `month.cost`, `forecast.projectedCredits`, `forecast.projectedCost`, `velocity.creditsPerHour`, `window7d.credits`, `currentBranchCredits`, `budget.percentOfBudget`, `budget.percentOfIncluded` | the same name |
| `budget.usedCredits` / `budget.usedCost` | `month.credits` / `month.cost` |
| `model["gpt-4.1"].credits` / `.cost`, `repo.my-app.credits` / `.cost` | `model:gpt-4.1.credits`, `repo:my-app.credits`, ... |

The message text is not carried over (flat rules have a fixed message).

**Not converted** (each is listed with its reason in the output channel, and stays in `config.json.migrated`): `and` / `or` / `not` and other combined conditions, `match: "none"`, several conditions in one rule, `in` and `matches`, comparing two variables, a bare variable or `true`/`false` as the condition, `requiresAuth`, `active` and rule `groups`, `vars`, a `snoozeUntil` that is still in the future, token counts, `topModel`/`topRepo`/`surface.*`, `billing.*`, `signedIn`, `now.*`, `branchBudgets.*` (per-branch caps are the `mallard.branchBudgets` setting), and a repeated id. Recreate the ones you still need with the rules above.

Two differences to expect: a converted rule that fired again at *exactly* its cooldown (the old language allowed it) now waits until the cooldown has passed, like the built-in alerts always did; and a velocity restriction, which never matched before, now does.
