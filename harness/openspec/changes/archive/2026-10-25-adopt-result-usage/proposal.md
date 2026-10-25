# Proposal

## Why

Umbrella #607 turns each rule of the lint preset back on in harness. The
`#609` move left `must-use-result` off for the test globs in
`typecheck.config.ts` behind the `#712` comment, because the type check
command — unlike the ESLint plugin before it — sees the dropped `Result` of
an awaited call. Measured on this branch with the rule forced on, it reports
76 sites over 19 test files: a test awaits `tool.execute(...)` or an engine
call, drops the `Result`, and asserts side effects, so an `err` return can
pass unseen under assertions that never read it.

## What Changes

- Turn the rule on for the tests: the `off` override for
  `**/*.test.{ts,tsx}` in `typecheck.config.ts` — its comment and its entry —
  goes away. The `src/**` override then covers each test file, because every
  test file of the harness sits under `src/`.
- One helper, `awaitOk`, in a new `src/lib/test/result-assert.ts`: it awaits
  a `Result`-bearing call and unwraps the ok, so a test states that the call
  succeeded. Its name joins the `consumers` list of the `src/**` override. No
  directive at any site.
- Each of the 74 call sites wraps its call in `await awaitOk(...)` and
  drops the inner `await`. The two `isResult` lines of
  `src/lib/test/result.test.ts` keep their shape — `isResult` joins the
  `consumers` list, because a `Result` that flows into the type guard is
  inspected, not dropped.
- The deliberate drop at `src/workflows/execute-analysis.ts` keeps its
  directive. Nothing else in `src` changes.
- One pull request for the whole issue, in the `#710`-to-`#708` pattern of
  the stack.

## Capabilities

### New Capabilities

- `result-usage`: the type check configuration of the harness keeps
  `must-use-result` on for `src/**` — which holds every test file of the
  harness — and the run reports nothing; the sanctioned consumer names —
  the helpers and bridges a `Result` may flow into — are recorded with
  their reasons.

### Modified Capabilities

(none)

## Impact

- `harness/typecheck.config.ts`: the test-glob `off` override goes away; the
  `consumers` array gains `awaitOk` and `isResult` with their comment lines.
- `harness/src/lib/test/result-assert.ts`: the new `awaitOk` helper, beside
  the `text-shapes.ts` precedent of a shared test helper under
  `src/lib/test/`.
- The 19 test files that hold the 76 sites — 18 of them edited,
  `result.test.ts` covered by the consumer entry — led by
  `tools/research/test/generate-plan.test.ts` with 19,
  `tools/knowledge/test/knowledge-tools.test.ts`,
  `tools/memory/test/update-working-memory.test.ts`, and
  `tools/workspace/test/execute-command.test.ts` with 9 each,
  `execution/test/run-synthesis.test.ts` with 6, and 14 files with 1 to 3
  sites each. No production module changes; no declared signature changes;
  nothing joins the barrel.
- The cli cross-gates of the stack: the harness build feeds the linked
  package, and the cli typecheck and test suite must stay green against it.
