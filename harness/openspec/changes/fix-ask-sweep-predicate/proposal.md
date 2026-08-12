## Why

`sweepExpired` expires *every* `pending` ask (`WHERE status = 'pending'`, no age
predicate). Managed hosts run the sweep on every pod boot, so a rolling
deployment would expire every live pending approval fleet-wide — an ask being
actively polled on one pod is killed by another pod booting. Dormant today (no
production tool calls `ctx.ask` yet) but must be fixed before approval-gated
tools ship.

## What Changes

- `sweepExpired` gains an age predicate: only `pending` rows whose `created_at`
  is older than a max age are swept to `expired`. Fresh pending asks survive a
  boot sweep.
- `AskGateway.sweepExpired()` becomes `sweepExpired(maxAgeMs?: number)` with a
  24-hour default (`DEFAULT_SWEEP_MAX_AGE_MS`) — far beyond any plausible live
  turn, so a rolling-deploy boot cannot expire an ask another pod still polls.
  Existing zero-arg callers keep compiling and get the safe default.
- No DDL change: the ledger has no deadline column and `src/state/init.ts` is
  owned elsewhere; `created_at` (fixed-width UTC ISO text, already relied on for
  ordering) carries the age predicate.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tool-approval`: the boot-sweep requirement changes from "sweep every pending
  row" to "sweep only pending rows older than the sweep max age" — a live
  pending ask survives a concurrent boot.

## Impact

- `src/tools/approval/queries.ts` — sweep SQL gains `AND created_at < $2`.
- `src/tools/approval/gateway.ts` — `sweepExpired(maxAgeMs?)`, default exported
  as `DEFAULT_SWEEP_MAX_AGE_MS`.
- `src/tools/approval/gateway.test.ts` — sweep suite covers survive-fresh,
  sweep-stale, mixed count, explicit max age.
- Embedders calling `askGateway.sweepExpired()` at boot are unaffected
  source-wise; behavior tightens to orphans only.
