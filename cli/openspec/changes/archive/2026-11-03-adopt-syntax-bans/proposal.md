# Proposal

## Why

Issue #808 (umbrella #608) turns on the three bans of `eslint-js/no-restricted-syntax` that the oxlint move (#610) left off under the `#808` comment: `regex`, `jsonParse`, and `timers`. With the bans on, this branch gives 486 reports: regex 300 (110 in the source, 6 of them in `oxlint.config.ts`, and 190 in the tests), `JSON.parse` 91 (21 and 70), and raw timers 95 (39 and 56). #608 is not done while a preset rule stays off outside the bun-types test exception.

## What Changes

- Remove the `syntax` switches and the `#808` comment from `cli/oxlint.config.ts`, thus the three bans are on in each override.
- One parse primitive: `JSON.parseResult(raw, schema)` in `src/extensions/json.ext.ts` gives a `Result` that keeps a malformed text apart from a schema mismatch. `JSON.parseWith` delegates to it. The tree keeps one `JSON.parse`, behind one directive. A test reads JSON through one throwing helper in `src/test_support/`.
- One timer primitive: `runAfter` and `runEvery` in `src/lib/timer.ts`. Each gives a stop function and keeps the unref of the site that it replaces. Each calls the global timer at call time, thus fake timers keep their control. `Promise.sleep` uses `runAfter`. The tree keeps two raw timer calls, each behind a directive.
- Each regex takes the first fix of a tier order. The tiers are a string-method helper, a builtin or a zod schema, and a named pattern with a directive that states the intent. A test assertion gets the same result or a stricter one, never a weaker one.
- A route schema replaces `.regex(...)` with one `.refine(...)` with the same message, and the GEO accession check becomes a zod string schema. No cli schema goes to a model or to `z.toJSONSchema`, thus no JSON Schema `pattern` is lost (#733, section 4).
- Each tolerant boundary keeps its outcome for a malformed text, also the reads that its `catch` covers today (#733, W1).
- Three independent reviewers (Codex, Pi, a Claude reviewer) and the coordinator chose each decision. Design D1 to D8 records the decisions, the reviewer record, and the dissent.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `syntax-bans`: add one requirement. The `regex`, `jsonParse`, and `timers` bans report nothing, and no option or override turns them off. The fix shapes are design rules of this change, not spec obligations.
- `unit-test-coverage`: the requirement "Global extensions are tested" adds `JSON.parseResult` and its two error kinds.

## Impact

- Configuration: `cli/oxlint.config.ts`.
- New files: `src/lib/timer.ts`, `src/lib/text.ts`, `src/test_support/json.ts`, `src/test_support/text_shapes.ts`, and their tests.
- Changed helpers: `src/extensions/json.ext.ts`, `src/extensions/promise.ext.ts`, and their tests.
- Source: each file under `src/` and `scripts/` with a report. The largest are `src/modules/infra/setup.ts`, `src/modules/geo/geo.ts`, `src/modules/harness/inflexa_tool.ts`, `src/modules/sbom/`, and `scripts/build.ts`.
- Tests: each test file with a report. The largest are `src/server/routes/test/usage.test.ts`, `src/modules/prov/test/prov.test.ts`, `src/tui/components/test/run_block.render.test.tsx`, and `src/modules/libs/test/store_flight.test.ts`.
- No wire format, route response, database schema, or provenance change. No new dependency.
- Behavior differences: design D7 lists each. The known differences are the failure output of `scripts/build.ts` for a malformed `package.json`, and the case fold of the stderr classifiers on non-ASCII text.
