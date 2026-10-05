## 1. Sweep predicate

- [x] 1.1 Add `AND created_at < $2` (text ISO cutoff) to the sweep UPDATE in `src/tools/approval/queries.ts`; `sweepExpired(querier, expiredAt, olderThan)`
- [x] 1.2 Change `AskGateway.sweepExpired()` to `sweepExpired(maxAgeMs?: number)` in `src/tools/approval/gateway.ts`, computing the cutoff from one `Date.now()`; export `DEFAULT_SWEEP_MAX_AGE_MS = 24h`

## 2. Tests

- [x] 2.1 Sweep suite in `src/tools/approval/gateway.test.ts`: stale rows past max age are swept and counted
- [x] 2.2 A fresh pending ask survives a sweep (status stays `pending`, count 0)
- [x] 2.3 Mixed stale + fresh: count reflects only swept rows
- [x] 2.4 Explicit `maxAgeMs` override is honored

## 3. Verify

- [x] 3.1 `npx tsc --noEmit` clean
- [x] 3.2 `bun test src/tools/approval/` green (17 pass)
