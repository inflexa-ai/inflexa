## 1. The ledger operation

- [x] 1.1 Add `completeEmptyDataProfile` to `src/state/data-profile.ts` with the `UNSEEDED` predicate
- [x] 1.2 Export it from `src/state/index.ts`

## 2. The trigger route

- [x] 2.1 Add `"completed"` to `DataProfileTriggerResult`
- [x] 2.2 Route an empty manifest against an empty seed to `completeEmptyDataProfile`
- [x] 2.3 Keep the refusal of an empty manifest against a seed that names files
- [x] 2.4 Narrow the unseeded refusal to a manifest that names files

## 3. Tests

- [x] 3.1 `state/data-profile.test.ts`: the stamp, the three refusals, and the rerun claim after a reseed
- [x] 3.2 `tasks/data-profile.trigger.test.ts`: the `"completed"` route, `already_running`, no row, and the narrowed refusals

## 4. Specs

- [x] 4.1 `data-profile-rerun`: add the empty-set completion requirements, and narrow the trigger rejection requirement
