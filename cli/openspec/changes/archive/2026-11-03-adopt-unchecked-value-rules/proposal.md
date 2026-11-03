# Proposal

## Why

Issue #805 (umbrella #608) turns back on the six preset rules that the oxlint move (#610) left off under its `#805` entries: the `typescript/no-unsafe-*` family and `@inflexa-ai/no-conditional-spread`. It also holds the decision on `exactOptionalPropertyTypes`. On this branch the rules report 306 sites (118 `no-unsafe-*`, 188 conditional spreads), and #608 is not done while a preset rule stays off outside the bun-types test exception.

## What Changes

- Record the decision on `exactOptionalPropertyTypes`: the flag stays off in `cli/tsconfig.json`. Three independent reviewers (Codex, Pi, a Claude reviewer) and the coordinator chose this option. The reason and the reviewer record are in design D1.
- Remove the six `off` entries and their `#805` comment from `cli/oxlint.config.ts`.
- Fix each `typescript/no-unsafe-*` report by a type at the source of the value: a schema parse at the boundary, a type argument, an explicit `unknown` with a narrowing, or a typed test helper. No `as` cast, non-null `!`, `any`, or directive without a recorded reason hides an `any` (design D3).
- Fix each conditional spread with no change to the keys that a consumer sees: a direct property where no consumer can tell an absent key from an `undefined` value, and an absent key (a named variable with an `if`, or a shared helper where the shape repeats) where a consumer can (design D2). This prevents the defect class of #733 W2-W4.
- Add a test for each consumer that observes key presence and that has no test for it yet. Keep each existing test at its strength.

## Capabilities

### New Capabilities

- `type-strictness`: the compiler strictness and the lint rules that keep the values of cli typed. It records that `exactOptionalPropertyTypes` stays off and why, and that the six rules of this change report nothing and have no `off` entry.

### Modified Capabilities

None. The fixes keep the behavior of each existing capability.

## Impact

- Configuration: `cli/oxlint.config.ts` (the `#805` entries go). `cli/tsconfig.json` does not change.
- Source: the files under `cli/src/` and `cli/scripts/` that hold a report (the lists are in `tmp/claude/805/` of the repository root during the change). The largest are `src/server/routes/conversation.ts`, `src/modules/harness/prov_bridge.ts`, `src/modules/refs/commands.ts`, `src/modules/libs/store_download.ts`, `src/server/routes/runs.ts`, `src/tui/app_config.tsx`, and `src/modules/harness/content-pack.ts`.
- Tests: the test files that hold a `no-unsafe-*` report, and new presence tests in the `test/` folder of each consumer module.
- No dependency, API, wire, database, or provenance change. If the key set of an object that a consumer reads changes, that is a defect of this change.
