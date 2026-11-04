# Proposal

## Why

The cli lint stack of umbrella #608 (#610 to #811) left findings that its issues did not fix. A client file can reach the server side through a computed `import()` path. A harness lint comment and a cli doc are false. Some tests depend on the order of the suite, and one test has an assertion count that depends on the timing. A route test keeps a cast only because a harness pool type is wider than its use. The user asked for one change on top of the stack that fixes these findings.

## What Changes

- The client import boundary of `cli/oxlint.config.ts` also refuses a dynamic `import()` in `src/tui/` or `src/client/` whose source is not written out: a source that is not a string literal or a template literal with no interpolation. The test `src/client/test/import_boundary.test.ts` pins the new entry (design D1).
- The comment at `harness/oxlint.config.ts:3-5` gives the true reason for the vendored `js/recommended` set: no public path of the plugin gives a named copy of it. The set stays (design D2).
- The tsgolint panic did not occur again in 220 bounded runs, and no release note names its cause. No version changes. The design records the evidence (design D3).
- The exit indicator test that loops an `expect()` over the frames of a real timer asserts the frames in one assertion. Thus its assertion count does not depend on the timer schedule. A per-test diff of Linux runs shows that this test is the only one whose count differs between #813 and #814. CI gives no per-test count, thus the CI difference is attributed to it by inference (design D4).
- The randomized runs found tests that depend on the order of the suite. Each such test sets its own precondition, and it restores the process-wide state that it changes. A new helper of `src/test_support/` replaces a property of a process-wide object for one test and restores its original descriptor. Each test that replaces a property of a stdio stream uses it (design D5).
- `createRunEventStream` of the harness types its pool as the harness `Querier`, because it reads only `query`. cli then removes the cast of `asHarnessPool` (`src/server/routes/test/runs.test.ts`). The cast of `fakeCollector` (`src/test_support/fake_collector.ts`) stays, because its records omit fields that the harness record type requires (design D6).
- Each constant fetch double of the form `() => Promise.resolve(new Response(...))` uses `respondWith` of `src/test_support/fake_fetch.ts`, except a double whose body is a stream (design D7).
- The doc of `Number.prototype.formatBytes` names `formatIecBytes` as the second byte formatter, for the IEC readouts of the package store. No user-visible text changes (design D8).
- No behavior of the product changes. The changes are in the lint configuration, the tests, the test support, the comments of the findings, and one harness type.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: the requirement "A client reaches the server state only through the API" also refuses a dynamic `import()` whose source the rule cannot read.
- `test-harness`: a new requirement makes each test independent of the order of the suite. A second new requirement keeps the assertion count of a test independent of the timing.

## Impact

- Configuration: `cli/oxlint.config.ts`, `harness/oxlint.config.ts` (a comment only).
- Harness source: `harness/src/execution/run-event-stream.ts`. The pool type is a widening, thus no embedder breaks.
- cli source: the doc of `src/extensions/number.ext.ts`.
- cli tests and test support:
  - `src/client/test/import_boundary.test.ts`
  - the test files of design D4 and D5, and a new helper file in `src/test_support/`
  - `src/server/routes/test/runs.test.ts`
  - the fetch-double sites of design D7
- No wire format, route response, database schema, provenance, or user-visible text change. No new dependency, and no version change.
