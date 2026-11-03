# Proposal

## Why

Issue #809 (umbrella #608) turns on `typescript/require-await`, which the oxlint move (#610) left off under the `#809` comment in `cli/oxlint.config.ts`. With the rule on, this branch gives 410 reports in 71 files: 402 in 63 test files, and 8 outside the tests (5 in the source, 3 in `src/test_support/`). Most reports are `async` test doubles that await nothing. #608 is not done while a preset rule stays off outside the bun-types test exception.

## What Changes

- Remove the `typescript/require-await` entry and its `#809` comment from the `off` block of `cli/oxlint.config.ts`. The rule is then on in each file, the tests included.
- Each test double keeps the contract that a caller of the real function sees. A double for a function that returns a Promise still returns a Promise, and a double whose real function rejects still rejects. `async` goes away, and the double returns `Promise.resolve(value)`, `Promise.reject(error)`, or `Promise.try(() => body)` when its body can throw (design D1, D2).
- One builder for each repeated shape: `streamOf` in `src/test_support/` for the async generators over a fixed list, behind one directive, and `respondWith` in `src/test_support/fake_fetch.ts` for the constant fetch doubles. A local builder that takes an async factory takes a sync value instead and makes the Promise itself (design D3, D4).
- The source: `renderChat` and `sandboxPull` become sync functions and their callers drop the `await`. `registerOnBus` becomes sync, and `register` runs it through `Promise.try`, thus a throw from a bus subscriber still comes back as a refusal. A new test covers that throw path (design D5).
- A lint fix does not make a test weaker: no `expect` call goes away, and no test gets a bare `return Promise.resolve()` to satisfy the rule (#733, W5).
- Three independent reviewers (Codex, Pi, a Claude reviewer) and the coordinator chose each decision. Design "The reviewer record" records the votes and the dissent.

## Capabilities

### New Capabilities

- `test-shape`: the `typescript/require-await` and `typescript/no-implied-eval` rules of the cli oxlint configuration stay on and report nothing. This mirrors the harness capability of the same name. The fix shapes are design rules of this change, not spec obligations.

### Modified Capabilities

None.

## Impact

- Configuration: `cli/oxlint.config.ts`.
- New and changed test helpers: `src/test_support/fake_fetch.ts` (`respondWith`), one new `streamOf` builder in `src/test_support/`, `src/test_support/fake_client.ts`, `src/test_support/fake_pool.ts`, `src/test_support/server.ts`, and their tests.
- Source: `src/modules/harness/prov_bridge.ts`, `src/tui/app.launch.tsx`, `src/tui/commands.tsx`, `src/modules/libs/pull.ts`, `src/cli/index.ts`, `src/modules/infra/searxng_config.ts`.
- Tests: each test file with a report. The largest are `src/modules/infra/test/setup.test.ts`, `src/modules/harness/test/runtime.test.ts`, and `src/modules/harness/test/model_listing.test.ts`.
- No wire format, route response, database schema, or provenance change. No new dependency. No reachable behavior changes (design D6).
