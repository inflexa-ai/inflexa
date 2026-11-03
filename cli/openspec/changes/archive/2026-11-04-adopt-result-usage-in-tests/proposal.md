# Proposal

## Why

Issue #810 (umbrella #608) turns `must-use-result` back on in the tests of cli. The oxlint move (#610) turned the rule off for `**/*.test.{ts,tsx}` in `cli/typecheck.config.ts`, under a comment that names #810. With the `off` entry removed, this branch gives 49 reports in 18 test files. Most are an awaited call whose Result the test drops before it asserts side effects. Thus an err return can pass such a test without a signal. #608 is not done while the rule stays off in the tests.

## What Changes

- Remove the `off` entry and its `#810` comment from `cli/typecheck.config.ts`. The `src/**` entry then keeps the rule on for each file under `src/`, the tests included. No cli test file sits outside `src/`.
- Add one test helper, `awaitOk`, in the new file `src/test_support/result.ts`, with the name and the signature of the harness helper (`harness/src/lib/test/result-assert.ts`). It awaits a call and gives the ok value. An err throws an `Error` whose `cause` is the err value, so the failure keeps a stack (#733). `awaitOk` joins the `consumers` option of the rule, with its reason in the comment of the entry (design D1).
- Each site that dropped an awaited Result now asserts it. A site whose call gives ok becomes `await awaitOk(<call>)`. A site whose call gives an err by design asserts the err value with `expect((await <call>)._unsafeUnwrapErr())`. No site only consumes a Result (design D2, D3).
- The two copies of the `frameChannel` stream double move into one shared helper in `src/test_support/stream.ts`. Its `yield` of a Result carries a `typecheck-disable-next-line must-use-result` directive with a reason, the precedent of `src/client/api.ts:208,218`. Each of the two yields of the generator double in `conversation.render.test.tsx` carries the same directive (design D4).
- `cli/CLAUDE.md` states that the rule is on in the tests, and names the two forms that state a Result in a test (design D5).
- A lint fix does not make a test weaker: no `expect` call goes away, and a site that dropped a Result now asserts it.
- Three independent reviewers (Codex, Pi, a Claude reviewer) and the coordinator chose each decision. Design "The reviewer record" records the votes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `result-types`: the requirement "must-use-result rule covers each file under src" replaces the requirement "must-use-result rule of the type check command", which turned the rule off for the test globs. The rule covers each file under `src/`, the tests included. No override turns it off, and `consumers` names the awaiting helper of the tests.

## Impact

- Configuration: `cli/typecheck.config.ts`.
- New test helper: `src/test_support/result.ts` (`awaitOk`) and its test under `src/test_support/test/`. Changed test helper: `src/test_support/stream.ts` (`frameChannel`).
- Tests: the 18 test files of the report list, for example `src/modules/harness/test/runtime.test.ts`, `src/modules/harness/test/inflexa_tool.test.ts`, and `src/modules/refs/test/commands.test.ts`.
- Docs: `cli/CLAUDE.md`.
- No product source change, no wire format, route response, database schema, or provenance change. No new dependency. No change to the harness.
