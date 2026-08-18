## 1. Delete the read-path decision

- [x] 1.1 Delete `src/app/data-profile-policy.ts` and its test
- [x] 1.2 Drop the staleness reason and import from `src/tools/research/inspect-data-profile.ts`; `stalenessReasons` no longer takes the result
- [x] 1.3 Drop the staleness reason and import from `src/tools/research/generate-plan.ts`

## 2. Re-point the tests at the new contract

- [x] 2.1 `inspect-data-profile.test.ts`: a completed row whose seed names unprofiled files is `ready`, not `stale`
- [x] 2.2 `generate-plan.test.ts`: the same row is served without a `PROVISIONAL` marking, facts intact
- [x] 2.3 The lifecycle `stale` cases (re-profile in flight, failed attempt over a prior result) still pass unchanged

## 3. Specs

- [x] 3.1 `data-profile-rerun`: add the push-only requirement; rewrite the snapshot requirement as an audit record
- [x] 3.2 `data-profile-init`: narrow the `stale` state's causes in the `inspect_data_profile` requirement
