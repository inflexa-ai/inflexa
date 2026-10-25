# Design

## Context

The type check command of the harness runs `must-use-result` from
`@inflexa-ai/typecheck` 0.8.0 over the program of `tsconfig.json`
(`src` and `scripts/**/*.ts`; no test file sits outside `src`).
`typecheck.config.ts` carries the rule on for `src/**` with the
`consumers` array — `unwrapOrThrow`, `passGate`, `deliverNotice`,
`keepSuspendingRefusal` — and a second override that turns the rule off
for `**/*.test.{ts,tsx}` behind the `#712` comment. Forced on, the rule
reports 76 sites over 19 test files on this branch (worklist:
the forced-on run of task 1.1). The dominant shape is a dropped
`await tool.execute(args, ctx)` (or an engine call) followed by
assertions on side effects; `src/lib/test/result.test.ts:55-56` passes a
fresh `Result` into the `isResult` type guard; the read-file throw site
at `src/tools/workspace/test/read-file.test.ts:116` asserts a throw, not
a `Result`. The rule implementation recognizes a `Result` that is a
direct argument of an identifier call named in `consumers`, and a
`Result` handled by `match`, `unwrapOr`, `_unsafeUnwrap`,
`_unsafeUnwrapErr`, `isOk`, or `isErr`.

## Goals / Non-Goals

**Goals:**

- The rule on for `src/**` — which holds every test file of the
  harness — with zero reports from the live `bun run typecheck`, and
  `bun run lint` and `bun test` green in harness.
- Each converted test states its call's outcome; a silent `err` return no
  longer passes under side-effect assertions.
- The cross-stack gates stay green: the harness build feeds the linked
  package, and the cli typecheck and test suite pass against it.

**Non-Goals:**

- The rules of the other children of #607: their `off` entries stay, and
  the bun-types test-glob exemption of `oxlint.config.ts` stays.
- The deliberate drop at `src/workflows/execute-analysis.ts:387` keeps
  its directive and its reason.
- No production module changes: no signature change, no barrel change, no
  new dependency, no helper for the err channel (the tree already states
  an err with `_unsafeUnwrapErr`, and no reported site expects one).

## Decisions

**D1 — The flip comes first, and a red typecheck is the sanctioned
mid-state.** Task 1.1 deletes the `off` override and extends
`consumers` before any site is fixed, in the #708 pattern, so each later
pass verifies its cluster against the live `bun run typecheck` instead
of a scratch configuration. The mid-state red holds exactly the 74 sites
that the wrap of D3 still owes (the `isResult` entry of the same task
clears the two guard sites).

**D2 — One awaiting helper, `awaitOk`, in a new
`src/lib/test/result-assert.ts`.** The helper awaits a `Result`-bearing
call and unwraps the ok, so its statement states that the call
succeeded:

```ts
export async function awaitOk<T, E>(
    call: Result<T, E> | Promise<Result<T, E>> | ResultAsync<T, E>,
): Promise<T> {
    return (await call)._unsafeUnwrap();
}
```

It lives beside the `text-shapes.ts` precedent — a shared helper of the
test files that several module families import — and its name joins
`consumers`, which is what makes the wrap legal to the rule. The
alternatives sit at the wrong layer: `src/lib/present.ts` is a
production module (11 non-test importers) of guaranteed reads, and
`src/lib/result.ts` owns the production Result glue — a test assertion
helper belongs in neither. A custom `expect` matcher would need a global
registration or a preload that the harness does not run, and it cannot
hand the ok value to a later assertion; the function does both.

**D3 — The site shape keeps the outer await and drops the inner one.**
Each drop becomes `await awaitOk(<the call expression>);` — the call
itself is no longer awaited at the site, the helper awaits it. The outer
`await` keeps the unwrap failure inside the test body instead of leaving
a floating promise. A site that turns red because its call returns an
`err` by design states its err directly — the tree's existing
`(await x())._unsafeUnwrapErr()` form — and never forces the call through
the helper and never takes a directive. The read-file throw site keeps
its try/catch: the seam throws before a `Result` exists, the throw
propagates through the helper, and the catch keeps asserting the thrown
message.

**D4 — `isResult` joins `consumers`.** The two flagged lines of
`result.test.ts` pass a fresh `Result` into the `isResult` type guard
and assert its boolean: the `Result` is inspected, not dropped. Binding
the `Result` to a variable first does not clear the report — the rule
tracks the argument flow, not the freshness of the expression — so the
guard is the one sanctioned inspection: a `Result` that flows into
`isResult` is consumed. `isResult` has no other call site in the tree
(its definition in `src/lib/result.ts` and its test), so the entry
changes no other site, and a future site that ignores the guard's
boolean is a dead read that no rule in this configuration catches
either way.

**D5 — The pass is scripted per cluster, in the #710 pattern.** One
repeatable edit script (or batch plan) per cluster of files: the whole
`src/tools` subtree in one pass (66 sites over 16 files), then
`src/execution`, `src/state`, and `src/lib` in one pass (10 sites over 3
files). Each pass loads its full context once and runs the module tests
of the files it changed; small slices would multiply the context cost
without changing the edit.

## Risks / Trade-offs

- [A wrapped site turns red because its call returns an `err` at
  runtime] → That red is the issue's point: the test now states its
  outcome. The pass treats it as a per-site finding and applies D3, and
  the module tests of the file confirm the restated assertion.
- [A mass pass over 76 sites regresses a test silently] → Each pass runs
  the module tests of the files it changed, and the last task runs the
  full harness suite and the cli cross-gates one time.
- [The `consumers` entries weaken the rule] → `awaitOk` exists only for
  the tests and unwraps — a call through it states its outcome by
  construction; `isResult` changes no other site today (D4). A future
  misuse of either name is a review concern, the same standing the four
  existing names already have.
- [The helper ships in `dist/`] → The build excludes only `*.test.ts`,
  `__tests__`, and `__fixtures__` files, so `text-shapes.ts` already
  ships the same way; the deep-import surface is additive and the barrel
  does not change.

## Migration Plan

One pull request. The flip and the helper land with the site passes in
the same change; a revert of the change restores the `off` override as
it stands on this branch.
