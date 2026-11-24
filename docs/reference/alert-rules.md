# Alert Rules Reference

Every field, operator, and context path available in a `config.json` rule.

## Rule fields

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Unique identifier; used for cooldown bookkeeping. |
| `severity` | no | `"info"`, `"warning"` (default), or `"critical"`. Ignored when `thresholds` is used, because each level carries its own severity. |
| `message` | yes | Notification text. Supports <code v-pre>{{ field.path }}</code> placeholders, including bracket paths such as <code v-pre>{{ model["gpt-4.1"].credits }}</code>. |
| `when` | one of three | JSONLogic condition that must be true for the rule to fire. See [Condition operators](#condition-operators). |
| `conditions` | one of three | Structured shorthand: an array of `{ "field", "op", "value" }` entries. See [Structured conditions](#structured-conditions). |
| `match` | no | How `conditions` combine: `"all"` (default, AND), `"any"` (OR), or `"none"` (NOR). Not used by `when`. |
| `thresholds` | one of three | Severity escalation: an array of `{ "field", "op", "value", "severity", "cooldown"? }` levels. The highest-severity level whose condition holds fires. |
| `active` | no | Gate: rule is skipped unless this condition is true. |
| `requiresAuth` | no | When `true`, the rule is skipped unless you are signed in to GitHub. |
| `cooldown` | no | Min time between firings: a positive number plus `m`, `h`, `d`, or `w`, in either case, decimals allowed (`"30m"`, `"1.5h"`, `"1d"`, `"1w"`). Default `1h`. Invalid values (`"0m"`, `"1 hour"`) are reported as configuration errors; at runtime an unusable value falls back to `1h`. |
| `snoozeUntil` | no | ISO 8601 timestamp. The rule is suppressed (alerts and restrictions) until then. An unparseable date does not snooze. |
| `notify` | no | Whether a fired rule shows a notification toast. Default `true`. Set to `false` to run a rule silently, for example one that only sets a `restrict` state. Ignored for rules with a `restrict` block, since those already show their own popup. |
| `restrict` | no | Copilot restriction block. See [Restriction fields](#restriction-fields). |

A rule needs at least one of `when`, `conditions`, or `thresholds`. If more than one is present they are not combined: **`thresholds` (when non-empty) wins over `when`, which wins over `conditions`**. The gates (`requiresAuth`, `active`, `snoozeUntil`) apply first, for alerts and restrictions alike.

## Condition operators

| Operator | Form |
| --- | --- |
| `>` `>=` `<` `<=` `==` `!=` | `{ ">": [{ "var": "today.credits" }, 100] }` |
| `and` / `or` / `not` | `{ "and": [cond, cond] }` · `{ "not": cond }` |
| `var` | `{ "var": "today.credits" }`: truthy check on a path into the live context |
| literal | `true` (always fire) · `false` (never fire) |

### Structured conditions

`conditions` and `thresholds` entries use `{ "field": "today.credits", "op": ">", "value": 100 }` and add two operators:

| Operator | `value` | Meaning |
| --- | --- | --- |
| `in` | array (or a single value) | The field equals one of the listed values, using the same equality as `==`. |
| `matches` | string pattern | Case-insensitive wildcard match against the whole value: `*` is any run of characters, `?` is exactly one, everything else is literal. Not a regular expression. A leading `^` or trailing `$` is accepted as an anchor (`"^claude-"` matches values starting with `claude-`). Patterns over 256 characters and values over 512 characters never match. |

`matches` only looks at strings, numbers, and booleans (numbers are compared as text); a missing field never matches.

### Comparison rules

These apply to every operator form, so `when`, `conditions`, and `thresholds` always agree:

- A missing (or `null`) value makes every operator false, except `!=`, which is true.
- `>` `>=` `<` `<=` need two numbers. A string counts only when it is plain numeric text (`"12"`, `"-3.5"`, `"1e3"`); other strings, booleans, `NaN`, and infinities give false.
- `==` and `!=` compare numerically when both sides are numbers or numeric strings (`50 == "50"`), and strictly otherwise.

### Variable paths

Paths are dot separated: `today.credits`. A key that itself contains dots or other punctuation goes in brackets with quotes: `model["gpt-4.1"].credits`, `repo['foo.js'].cost`. Use a backslash to escape a quote or backslash inside the key. Only the context's own values are readable, so names like `constructor` or `__proto__` never resolve.

## Context fields

| Path | Type | Description |
| --- | --- | --- |
| `today.credits` / `today.cost` / `today.tokens` | number | Usage today. |
| `month.credits` / `month.cost` | number | Month-to-date totals. |
| `month.tokens` | number | Month-to-date tokens, summed from the dashboard's daily totals. Missing when no daily data is loaded. |
| `window7d.credits` / `window7d.cost` / `window7d.tokens` | number | The last 7 calendar days, today included, from the dashboard's daily totals (so they follow the active filter). The whole `window7d` is missing when no daily data is loaded, and a missing value never satisfies a condition. |
| `budget.monthly` | number \| null | Monthly budget in USD. |
| `budget.usedCredits` / `budget.usedCost` | number | Credits / cost used this month. |
| `budget.percentOfBudget` | number | MTD cost as fraction of budget (0–1+). |
| `budget.percentOfIncluded` | number | Credits as fraction of included allowance. |
| `budget.projectedOverage` | number \| null | Projected overage in USD. |
| `budget.pace` | string | `"no-budget"`, `"under"`, `"on-track"`, `"warning"`, or `"over"`. |
| `forecast.projectedCredits` / `forecast.projectedCost` | number | Month-end projection. |
| `forecast.low` / `forecast.high` | number | Projection confidence bounds. |
| `forecast.basis` | string | Method used: `"linear"`, `"seasonal"`, or `"insufficient-data"`. |
| `velocity.creditsPerHour` | number | Recent spending rate: a least-squares fit of today's credits over the recent samples. When the daily counter drops (midnight, or a data recompute) the window restarts there. `0` until two samples exist after the restart. |
| `velocity.costPerHour` | number | `creditsPerHour` priced at the current price per credit, in the display currency. |
| `velocity.windowMinutes` | number | Length of the sample window the rate was fitted over. |
| `topModel.id` / `topModel.credits` | string \| null, number | Top model in the current snapshot window. |
| `topSurface.id` / `topSurface.credits` | string \| null, number | Surface with the most credits in the current snapshot window. |
| `topRepo.id` / `topRepo.credits` | string \| null, number | Top repo in the current snapshot window. |
| `model.<key>.credits` / `.cost` / `.tokens` | number | Totals for a specific model, e.g. `model.gpt-4o.credits`. Quote keys containing dots: `model["gpt-4.1"].credits`. |
| `surface.<key>.credits` | number | Credits for a specific surface, e.g. `surface.chat.credits`. Surfaces have no `cost` or `tokens` figures. |
| `repo.<key>.credits` / `.cost` / `.tokens` | number | Totals for a specific repo, e.g. `repo.my-app.credits`; `repo["foo.js"].cost` for keys with dots. |
| `billing.netAmount` / `billing.grossAmount` | number | GitHub billing net and gross charge (requires sign-in). |
| `billing.quotaPercentRemaining` | number \| null | Remaining plan quota as a **0–1 fraction** (`0.25` = a quarter left; negative once over quota). `null` without a quota (requires sign-in). |
| `billing.unlimited` | boolean | Whether the account has an unlimited Copilot plan (requires sign-in). |
| `now.weekday` / `now.hour` / `now.minute` / `now.ts` | number | Current time values (`weekday` is 0=Sun–6=Sat). |
| `now.iso` | string | Current time as an ISO 8601 string. |
| `signedIn` | boolean | Whether signed in to GitHub. |
| `currentBranch` / `currentBranchCredits` | string \| null, number | Active branch name and credits consumed on it. |
| `branchBudgets.<branch>` | number | Credit cap for the named branch, as set in the `branchBudgets` config key. Branch names often contain dots, so use `branchBudgets["release/1.2"]`. Compare against `currentBranchCredits`. |
| `vars.<name>` | any | User-defined variable (see `vars` block). |
| `group.<id>` | boolean | Whether the named group is active. |

## Restriction fields {#restriction-fields}

A rule's `restrict` block shows a popup with **Dismiss**, **Snooze 15m**, **Snooze 1h**, and **Disable Mallard...** when the rule fires. Restrictions are notification-level only: Mallard never disables Copilot or any extension automatically and does not enforce anything. **Disable Mallard...** opens the Extensions view so you can do it yourself in one click.

A restriction rule matches by exactly the same logic as an alert, including `thresholds`, `conditions`, `requiresAuth`, `active`, and `snoozeUntil`.

| Field | Values | Description |
| --- | --- | --- |
| `reEnableWhen` | condition | Optional. When this condition becomes true, the restriction clears itself automatically instead of waiting for a snooze to expire. Without it, a restriction clears once its rule stops matching. |
