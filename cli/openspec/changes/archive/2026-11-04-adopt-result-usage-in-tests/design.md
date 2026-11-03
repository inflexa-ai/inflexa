# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- `cli/typecheck.config.ts:5-15` sets `must-use-result` to `error` for `src/**` with `consumers: ["fromCatalogStart", "readImageSbom"]`. `:16-20` turns the rule off for `**/*.test.{ts,tsx}` under the `#810` comment. Each cli test file sits under `src/`. `tsconfig.json` includes `src/**/*` and `scripts/**/*`, and `scripts/` holds no test file.
- The rule (`node_modules/@inflexa-ai/typecheck/dist/rules/must-use-result.js`, version 0.8.0) visits each call, `new`, and `await` expression whose type is a Result. It counts these forms as handled (`:68-118`):
  - a call of `match`, `unwrapOr`, `_unsafeUnwrap`, `_unsafeUnwrapErr`, `isOk`, or `isErr`
  - a read of `.value` or `.error`
  - a Result inside an arrow function or a `return`
  - a direct argument of an identifier call named in `consumers`.
- The rule does not count a `yield` (only a `yield*` inside a `safeTry` callback, `:47-67`), and it does not count an argument of `expect(...)`.
- Measured on this branch (the real configuration without the `off` entry, run as `node node_modules/@inflexa-ai/typecheck/dist/cli.js --config <scratch config>` from `cli/`): 49 reports in 18 test files. The start list is `tmp/claude/810/scout-sites.txt` under `cli/`. After task 1.1, the live `bun run typecheck` is the worklist.
- The shapes:
  - 45 statements `await <call>(...);` whose Result the test drops, then asserts side effects. One of them is `await launchP;`, a Promise of a Result in a variable (`src/modules/embedding/test/local-provider.test.ts:868`).
  - Of the 45, the scout infers from the code that 3 calls give an err by design: `src/modules/infra/test/compose.test.ts:720`, `src/modules/infra/test/setup.test.ts:2824`, and `local-provider.test.ts:868`. One call throws inside a `try` whose `catch` records the throw (`src/modules/refs/test/commands.test.ts:880`).
  - 4 statements `yield ok(...)` in async generator doubles typed `AsyncGenerator<Result<ChatFrame, ClientError>>`: `src/tui/hooks/test/conversation.test.ts:112` and `src/tui/hooks/test/conversation.interrupt_retract.test.ts:71` inside `frameChannel`, and `src/tui/hooks/test/conversation.render.test.tsx:55,57`.
- The two `frameChannel` functions (`conversation.test.ts:99-136`, `conversation.interrupt_retract.test.ts:58-92`) have the same code and different doc comments. The source carries the same yield shape with a directive (`src/client/api.ts:208,218`).
- No test file holds a `must-use-result` directive today. The comments that explain a handled form (`setup.test.ts:1160-1161`, `resolve.test.ts:13-15`, `plan_intake.test.ts:93-95`, `model_listing.test.ts:30`, `compose.test.ts:421-422`, `boot.test.ts:54`) stay true with the rule on.
- The 18 test files (`tmp/claude/810/test-files.txt` under `cli/`) pass today: 872 pass, 1 skip, 0 fail, 3091 `expect()` calls (`tmp/claude/810/baseline.txt`).
- The harness did the same work in PR #731 (issue #712). Its review #733 asked that a failure of `awaitOk` throws an `Error` with the err value as its `cause`. The reason: `_unsafeUnwrap` throws a plain object with no stack. The harness helper now does that (`harness/src/lib/test/result-assert.ts:16-19`).

## Goals / Non-Goals

**Goals:**

- The rule on for each file under `src/`, zero reports from `bun run typecheck`, with `bun run lint` and `bun run test` green.
- Each site that dropped a Result states the outcome that the test intends: an ok, or an err with its value.

**Non-Goals:**

- The rules of #811. Their entries stay.
- No product source change. If a fix needs one, the implementor stops and reports (D3).
- No new dependency, and no change of the version of `@inflexa-ai/typecheck`. A change of the rule so that it follows a `yield` belongs to the lint package, not to this change.
- No second helper for the err channel (D2).

## Decisions

### The reviewer record

The coordinator wrote one brief (`tmp/claude/810/decision-brief.md` at the root of the repository) with the measurements and the options for each question. Three independent reviewers answered it. No reviewer saw the answer of another.

| Reviewer | Model | Q1 helper | Q2 err site | Q3 yields | Q4 spec | Q5 docs |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | gpt-6-sol, high reasoning | A, `awaitOk` | A, `_unsafeUnwrapErr` with `expect` | B, shared `frameChannel` | A, modify `result-types` | A, update |
| Pi | `viv-issue-reviewer` flavor, medium | A | A | B | A | A |
| Claude reviewer | sonnet, high effort | A | A | B | A | A |
| Coordinator | claude-opus-5-5 | A | A | B | A | A |

Each decision is unanimous. There is no dissent. The risks that the reviewers raised are in D3, D4, and "Risks / Trade-offs".

### D1: The flip comes first

Task 1.1 removes the `off` entry and adds `awaitOk` to `consumers` before any site changes. Then the live `bun run typecheck` is the worklist, and each later pass verifies its files against the real configuration, not a scratch one. A red type check between task 1.1 and the last site is the expected mid-state.

The `src/**` entry keeps its glob. The comment of the entry gives the reason of each consumer name. For `awaitOk`: it awaits a call in a test and gives its ok value. An err throws, so a call through it states that the call succeeded.

### D2: One helper, `awaitOk`, in `src/test_support/result.ts`

```ts
export async function awaitOk<T, E>(call: Result<T, E> | Promise<Result<T, E>> | ResultAsync<T, E>): Promise<T> {
    const result = await call;
    if (result.isErr()) throw new Error(`the call gave an err: ${describeCause(result.error)}`, { cause: result.error });
    return result.value;
}
```

- The name and the signature are those of the harness helper. Thus one name means one thing in the two packages, and each `consumers` list names it.
- `describeCause` (`src/lib/cause.ts`) renders the err value in the message, where the harness uses `textOf`. The `cause` holds the err value itself, so a test failure shows the stack and the whole value.
- The helper has a JSDoc block. The file holds only this helper, beside the other shared test helpers of `src/test_support/`.
- A test in `src/test_support/test/result.test.ts` covers these cases:
  - the ok value of a `Result`, of a `Promise<Result>`, and of a `ResultAsync`
  - an err that rejects with an `Error` whose `cause` is the same err value (`toBe`), and whose message holds the `describeCause` text.
- There is no `awaitErr`. An err-by-design site states its err with the form that the tree already uses (D3). The issue asks for one helper, and the harness made the same choice.

Alternatives rejected:

- A custom `expect` matcher (Q1, C). The rule counts only a direct argument of an identifier call named in `consumers`, not an argument of `expect(...)`. A matcher also cannot give the ok value to a later assertion.
- A second helper `awaitErr` (Q2, B). It adds a second consumer name for a small number of sites that the existing form covers.
- A bare `(await <call>)._unsafeUnwrapErr();` statement (Q2, C). It asserts that an err came, but not which err.

### D3: The shape of each site

The implementor reads the name and the assertions of the test to find the outcome that it intends. Then the implementor runs the test to confirm it.

- **The test intends an ok.** `await <call>;` becomes `await awaitOk(<call>);`. The call is no longer awaited at the site. The helper awaits it, and the outer `await` keeps a failure inside the test body. `await launchP;` becomes `await awaitOk(launchP);` if that call gives an ok.
- **The test intends an err** (its name or its assertions name a failure path). The site states the err value: `expect((await <call>)._unsafeUnwrapErr()).toEqual(<err>)`. The err can hold a value that the test does not own (a `cause`, a message from a library). Then the site uses `toMatchObject({ type: "<type>" })`, or `toBeInstanceOf(<class>)` for an err that is an `Error` class. The site asserts the err value that the code under test gives today.
- **The call throws** (`refs/test/commands.test.ts:880`). The site becomes `await awaitOk(<call>)` inside the same `try`. The throw passes through the helper unchanged, thus the `catch` records the same value, and its assertion stays exact.
- **The test intends an ok, and the call gives an err.** This is a hidden defect, not a fix shape. The implementor does not change the product code and does not weaken the test. The implementor records the site in `notes.md` and stops.
- **Not permitted:** `void <call>`, a bare `._unsafeUnwrap()` or `._unsafeUnwrapErr()` statement, a bare `.isOk()` or `.isErr()` with no `expect`, and a directive at an `await` site.

The 3 inferred err sites and the throw site come from a read of the code. The run of each test after the edit is the proof. `notes.md` records the outcome of each of these sites.

### D4: The yielded Results

The rule cannot see a Result that a generator yields to the `for await` of its reader. No form of a `yield` of a Result is clean to the rule, and the consumer types accept only `AsyncGenerator<Result<ChatFrame, ClientError>>`.

- `frameChannel` moves from the two test files into `src/test_support/stream.ts`, beside `streamOf`, as an exported function. The two test files import it and delete their copies. Two test files use it, so it is a shared helper.
- The body does not change. The order of `yield ok(item.frame)` and `item.applied()` stays. Thus a `send` still resolves when the reader asks for the next frame, after the consumer applied the frame. The doc comment merges the two comments and keeps that invariant. It also states that each frame is a copy (`structuredClone`), thus a later change by the sender cannot reach a queued frame.
- The yield carries one directive, with the text of the precedent in `src/client/api.ts:208`:

  ```ts
  // typecheck-disable-next-line must-use-result -- a yielded Result is consumed by the `for await` of the caller, which the rule cannot follow
  ```

- The generator double of `conversation.render.test.tsx:54-58` stays as it is, with the same directive at each of its two yields. It awaits a gate between the yields, thus `streamOf` and `frameChannel` do not fit it without a change of the test.

Alternatives rejected:

- A directive at each of the 4 yields (Q3, A). It keeps two copies of `frameChannel`. The loop rule asks for the abstraction that removes a repeated shape.
- An adapter `okEach(source)` in `src/test_support/` that yields `ok(item)` for each item of a stream of bare frames (Q3, C). It needs one directive only, but it adds an async step between the reader and each generator. `frameChannel` resolves `send` when the reader asks for the next frame, and those tests depend on that timing.

### D5: The spec and the docs

- The rule stays in `result-types` (Q4, A). The rule covers each file under `src/`, the tests included, and `consumers` names `awaitOk`. The scenario "The rule is off in the test globs" goes away. `openspec validate` refuses a MODIFIED block that drops a scenario of the main spec. Thus the delta removes the requirement "must-use-result rule of the type check command" and adds "must-use-result rule covers each file under src", which keeps each other scenario. A new capability that copies the harness `result-usage` spec (Q4, B) would only move a requirement that cli already holds.
- `cli/CLAUDE.md:106-110` states that the rule covers the tests too, and names the two forms of a test site: `await awaitOk(<call>)` for an ok, and `expect((await <call>)._unsafeUnwrapErr()).toEqual(<err>)` for an err (Q5, A). The old sentence names #810 as open work, which becomes false. No other doc changes.

### D6: The test strength

- A test edit does not remove or loosen an `expect` call. The count of `expect(` in the source text of each changed test file stays the same or grows. `notes.md` records the counts before and after. The counts before are in `tmp/claude/810/expect-before.txt` under `cli/`.
- The 18 test files give 0 fail after the change, with at least 872 pass and at least 3091 `expect()` calls. The 3091 is the count of the summary that `bun test` prints. The gate for each file uses the count of `expect(` in the source text, from `expect-before.txt`.

## Risks / Trade-offs

- [A wrapped call gives an err at run time] → That is the point of the issue: the test now states its outcome. D3 gives the shape for an err that the test intends, and a stop for an err that it does not intend.
- [The move of `frameChannel` changes the timing of a conversation test] → The body moves without a change. The tests of the two files run before and after the move.
- [`awaitOk` in `consumers` weakens the rule] → A call through `awaitOk` asserts its ok by construction. A future misuse of the name is a review concern, the same as for the other consumer names.
- [`describeCause` of an err value loses detail] → It renders only the message. The `cause` holds the whole value.

## Migration Plan

One pull request. The flip, the helper, and the site passes land together. A revert of the change restores the `off` entry.
