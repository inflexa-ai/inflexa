# Design

## Context

See proposal.md for the motivation. The facts that shape the approach:

- `cli/oxlint.config.ts:264-265` turns `typescript/require-await` off under the `#809` comment, in the last override block. The preset of `@inflexa-ai/oxlint-plugin` 0.8.0 sets the rule and `typescript/no-implied-eval` to `error` (`node_modules/@inflexa-ai/oxlint-plugin/dist/presets.js:66,110`). `no-implied-eval` reports nothing in cli today.
- The rule (the tsgolint port of typescript-eslint `require-await`, reference logic in `node_modules/@typescript-eslint/eslint-plugin/dist/rules/require-await.js:75-230`) reports an `async` function with no `await`, no `for await`, and no `await using`. It does not report an empty function or a function that returns a thenable. It does not report a generator that delegates to an async iterable or yields a thenable.
- Measured on this branch (oxlint 1.85.0, the real config without the `off` entry): 410 reports in 71 files, 402 in 63 test files. The start list with each source line is `tmp/claude/809/scout-sites.txt` under `cli/`. After task 1.1, the live lint run is the worklist. The 63 test files (`tmp/claude/809/test-files.txt`) pass today: 2183 tests, 0 fail, 7573 `expect()` calls (`tmp/claude/809/baseline.txt`).
- The shapes:
  - object-property doubles for a member that returns a Promise
  - about 62 `spyOn(...).mockImplementation(async () => ...)` spies
  - about 30 constant fetch doubles
  - about 15 doubles that throw where the real function rejects
  - 6 async generators over a fixed list
  - 2 `async` test callbacks with no await
  - 8 sites outside the tests (D5).
- No test holds an un-awaited `expect(...).rejects` or `.resolves` (the scout counted 17, each awaited). Thus no test has the defect of #733, W5, today. The risk is that a fix makes one.
- The tests use `Promise.resolve(` 250 times already. `Promise.try` exists in Bun 1.4.2 and in the TypeScript 6.0.3 lib (`node_modules/typescript/lib/lib.es2025.promise.d.ts:31`), and `tsconfig.json` loads `ESNext`. `Promise.try(fn, ...args)` calls `fn` at once and turns its return into a resolution and its throw into a rejection. That is the contract of an `async` function with no `await`.
- `must-use-result` of `inflexa-typecheck` is on for `src/**` and off for the test files until #810 (`typecheck.config.ts`). It treats a Result inside an arrow function or a `return` as used (`node_modules/@inflexa-ai/typecheck/dist/rules/must-use-result.js:92-97`). It does not treat a `yield` as a use, thus `src/client/api.ts:208,219` carry a directive for each yielded Result. `setup.test.ts:1160` and `compose.test.ts:421` keep `mockImplementation`, not `mockResolvedValue`, for a spy that gives a Result.
- `typescript/await-thenable` is off for `**/*.test.{ts,tsx}` only (`oxlint.config.ts:251-255`). A file in `src/test_support/` is not a test file, thus the rule applies there. It also applies to each `await` of a function that this change makes sync.
- The harness did the same work in PR #730 (issue #710), capability `harness/openspec/specs/test-shape/spec.md`. Its review #733 names the defect class for this change: a lint fix that satisfies the rule and adds no check (W5, and "Lint fixes that weaken a test").

## Goals / Non-Goals

**Goals:**

- The rule on, zero reports from `bun run lint`, with `bun run typecheck` and `bun run test` green.
- Each double keeps the sync or async contract that a caller of its real function sees, and each double that rejects still rejects.
- One builder for each shape that repeats across files.

**Non-Goals:**

- The rules of #810 and #811. Their entries stay, and a fix adds no site for them. A fix does not add a Result where `must-use-result` would report it after #810 (D3).
- No public wire type, route response, database schema, or provenance change. No change to the harness.
- No new dependency, and no change of the oxlint or plugin version.
- No new assertion style. A test keeps its assertions. This change adds tests only where D3, D4, and D5 name one.

## Decisions

### The reviewer record

The coordinator wrote one brief (`tmp/claude/809/decision-brief.md` at the root of the repository) with the measurements and the options for each question. Three independent reviewers answered it. No reviewer saw the answer of another.

| Reviewer | Model | Q1 plain double | Q2 throwing double | Q3 generators | Q4 fetch | Q5 source | Q6 spec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | gpt-6-sol, high reasoning | A, inline | A | A, one builder | A, `respondWith` | A, A | A, `test-shape` |
| Pi | `viv-issue-reviewer` flavor, medium | A, inline | A | A, one builder | A, `respondWith` | A, A | A, `test-shape` |
| Claude reviewer | sonnet, high effort | A, inline | A | A, one builder | B, inline | A, A | A, `test-shape` |
| Coordinator | claude-opus-5-5 | A, inline | A | A, one builder | A, `respondWith` | A, A | A, `test-shape` |

Each decision takes the majority. The dissent:

- Q4: the Claude reviewer voted for an inline `() => Promise.resolve(new Response(...))` at each site. The reason: an arrow already makes a fresh `Response` on each call, thus a builder only renames `new Response`. The majority rejected it: the same three-part shape occurs at about 30 sites in many files, and the loop rule asks for the abstraction that removes the shape. `fakeFetch` already owns the fetch-double concern.

The risks that the reviewers raised are in D2 (a body that can throw), D3 (the directive and `must-use-result`), D5 (the test of the throw path of `registerOnBus`), and D6.

### D1: The shape of a double

The type of the real member decides the shape, not the body of the double. The implementor reads the type of the parameter, the injected function, or the spied function that the double stands for.

- **The real member returns a Promise** (`Promise<T>`, or a type that only a Promise satisfies). Remove `async` and keep a Promise:
  - An expression body that cannot throw returns `Promise.resolve(value)`. The `undefined` value gives `Promise.resolve()`.
  - A block body that cannot throw keeps its statements and ends with `return Promise.resolve(value)`. A body that only records into a local array or sets a local variable cannot throw.
  - A body that can throw follows D2.
- **The real member accepts a sync value** (`T | Promise<T>`, `T`, or `void`). Remove `async` and return the value. This is correct only where the caller handles a sync throw and a rejection the same way. An example is a caller that awaits the value inside an `async` function (`fakePool`, `src/test_support/fake_pool.ts:12-17`). Where the caller does not, follow the Promise case.
- **A spy.** `spyOn(mod, "fn").mockImplementation(async (...) => x)` becomes `mockImplementation((...) => Promise.resolve(x))`, with the same rules for the body. A spy that gives a Result keeps `mockImplementation`. It does not become `mockResolvedValue` (`setup.test.ts:1160`).
- **A test callback.** An `async` test callback with no await (`src/server/test/boot.test.ts:149`, `src/tui/contexts/test/workspace.test.ts:92`) drops `async`. It does not get a `return Promise.resolve()`.
- **Not permitted:**
  - a bare `return Promise.resolve()`, or an `await` that adds nothing (`await Promise.resolve()`, `await null`), only to satisfy the rule
  - a directive, except in D3
  - a sync return where the real member returns a Promise.

`bun run typecheck` is a backstop for the Promise case: a double without `async` that returns a plain value for a member typed `Promise<T>` is a type error. It is not a backstop for a sync throw (D2).

Alternatives rejected:

- A builder in `src/test_support/` that gives `() => Promise.resolve(value)` (Q1, B). It renames a standard expression that the tests already use 250 times. A Result passed as its argument would also be a `must-use-result` report after #810.
- A directive at each site (Q1, C). It leaves the shape and adds about 400 directives.

### D2: A double that throws keeps its rejection

A double whose real function rejects must still reject. A sync throw from a member that returns a Promise escapes a caller that wraps the call in `ResultAsync.fromPromise` (`src/client/api.ts:251`) or that chains `.then`. Thus a fix that turns a rejection into a sync throw changes the outcome of the test. Some callers hide the difference, for example `src/modules/update/latest.ts:68-71`, thus a green test does not prove the shape.

- A body that only throws becomes `Promise.reject(error)`, with the same error value.
- A body that runs code that can throw becomes `Promise.try(() => { ...body })`. Code that can throw includes a parse, an `expect`, and `refuse(...)` (`src/test_support/harness_stubs.ts:4`). It also includes a call of the code under test or of an injected function, and a `new Response` with a computed status. When the implementor is not sure, the body takes `Promise.try`.
- `src/test_support/fake_client.ts:26` takes `Promise.try`: its body calls `parsedJson` and `answer`, which can throw.

The sites that the scout found are `src/client/commands/test/server.test.ts:85`, `src/modules/geo/test/geo.test.ts:292,648`, `src/modules/update/test/latest.test.ts:46`, `src/server/test/http.test.ts:214`, `src/modules/harness/test/model_listing.test.ts:38,317`, `src/modules/harness/test/runtime.test.ts:766`, `src/modules/refs/test/commands.test.ts:1028`, `src/server/routes/test/runs.test.ts:98`, and `src/tui/test/plan_steps_command.test.tsx:16`. The live lint run can show more. `notes.md` ("New shapes") records that `model_listing.test.ts:38,317`, `latest.test.ts:46`, and `runs.test.ts:98` hold no throwing body.

Alternatives rejected:

- `Promise.resolve().then(() => body)` (Q2, B), the form of `latest.ts:71`. It runs the body one microtask later, which an `async` function does not do.
- `Promise.try` for each block body (Q2, C). It wraps bodies that cannot throw, which adds noise for no change of behavior.

### D3: One builder for a stream over a fixed list

The consumer types of a chat stream are `AsyncGenerator` (`src/client/conversation.ts:175`, `src/tui/hooks/conversation.ts:1156`, and `ChatTurns.read` of the harness), thus a double must be an async generator. The 6 generators over a fixed list use one builder in the new file `src/test_support/stream.ts`: a generic `streamOf<T>(items: Iterable<T>): AsyncGenerator<T>` that yields each item in order. The builder is an `async function*` that awaits nothing, thus it carries the one directive of this change:

```ts
// oxlint-disable-next-line typescript/require-await -- an AsyncGenerator over a fixed list has nothing to await, and the consumer types require an AsyncGenerator
```

The builder yields a value of the type parameter `T`, thus `must-use-result` does not report its `yield`. A site that streams Results passes them in the argument list inside an arrow function, for example `startTurn: () => okAsync({ turnId, frames: streamOf([ok(frame), err(broken)]) })`, where the rule treats them as used. A test can name the stream in a statement before the use. Then the implementor puts the call in the arrow, or keeps a local helper that returns it. `framesOf` of `src/tui/test/plan_steps_command.test.tsx:16` becomes a call of `streamOf` with the mapped frames. The `read` member of `src/server/routes/test/conversation.test.ts:142` becomes `read: () => streamOf(frames)`.

The builder has a test under `src/test_support/test/`: it yields each item in order and then ends, and an empty list ends at once.

Alternatives rejected:

- `for await (const item of items) yield item` over the sync list (Q3, B). It satisfies `require-await`, but `typescript/await-thenable` reports a `for await` over a value that is not async-iterable, and that rule is on in `src/test_support/`.
- A directive at each of the 6 sites (Q3, C).

### D4: One builder for a constant fetch response

`src/test_support/fake_fetch.ts` adds `respondWith(body?: BodyInit | null, init?: ResponseInit): () => Promise<Response>`. Each call of the returned function makes a new `Response` through `Promise.try`. Thus a body reads one time for each call, and a constructor throw rejects. The returned function fits each fetch type of the tree that takes fewer parameters (`FetchLike`, `ClientOpts.fetch`, the fetch parameters of `model_listing.ts`), and `fakeFetch(respondWith(...))` fits `globalThis.fetch`.

- Each constant double `async () => new Response(body, init)` becomes `respondWith(body, init)`.
- A double that closes over one `Response` object (for example `src/lib/test/download.test.ts:86`) keeps that object: `() => Promise.resolve(response)`. A double with logic stays inline per D1 and D2.
- A local builder can take an async factory, for example `recordingFetch(res: () => Promise<Response>)` at `src/modules/harness/test/model_listing.test.ts:58`. Such a builder takes a sync value or a sync factory instead, and makes the Promise itself per D1 and D2. Thus its call sites lose `async`.
- One test file can hold one multi-line double shape at three or more sites. Then a local builder in that file removes it. A shape that two or more test files hold goes to `src/test_support/`. The implementor extends an existing helper before adding one.

`respondWith` has a test under `src/test_support/test/`. Two calls give two readable bodies with the same text and the given status. An init with a status that `Response` refuses (for example `{ status: 1 }`) gives a rejection with a `RangeError`, not a sync throw.

### D5: The sites outside the tests

- `src/tui/app.launch.tsx:32` `renderChat` and `src/modules/libs/pull.ts:155` `sandboxPull` have sync bodies. Each drops `async` and returns `void`. Each caller drops its `await` (`app.launch.tsx:139,145,152`, `src/cli/index.ts:1015`), because `typescript/await-thenable` reports an `await` of a value that is not a thenable. Each caller is an `async` function, thus a throw from the callee still rejects the caller.
- `src/modules/harness/prov_bridge.ts:234` `registerOnBus` drops `async` and returns `ExternalRegistrationResult`. `register` (`:362-364`) calls `ResultAsync.fromPromise(Promise.try(registerOnBus, input), ...)`. Thus a throw from a bus subscriber or the QName mint still comes back as the refusal that the comment at `:360-361` promises. Today no test covers that path. The implementor adds one to `src/modules/harness/test/prov_bridge.test.ts` before the edit: a bus subscriber that throws gives an `Err` whose `reason` starts with `provenance registration threw: ` and holds the message, with `suspend: false`. The test passes before and after the edit.
- `src/tui/commands.tsx:2122`: the error callback of `.match` drops `async`. `match` gives a Promise of either callback, thus a throw from `notify` still rejects the awaited result.
- `src/modules/infra/searxng_config.ts:39`: `onExisting` becomes `() => Promise.resolve(ok(undefined))`. Its type is `() => Promise<Result<...>>` (`src/modules/infra/mount_source.ts:102-106`).
- `src/test_support/server.ts:48`: `start` becomes `() => Promise.resolve()`. `src/test_support/fake_pool.ts:30`: `connect` becomes `() => Promise.resolve({ ...pool, release: () => {} })`. `src/test_support/fake_client.ts:26` follows D2.

Alternatives rejected:

- A `Promise<void>` return of `Promise.resolve()` for `renderChat` and `sandboxPull` (Q5, B). It keeps a Promise that no caller needs.
- `Result.fromThrowable(registerOnBus, ...)` lifted to a `ResultAsync` for `registerOnBus` (Q5, B). It needs a second step to lift the Result, where `Promise.try` keeps the one `fromPromise`.

### D6: The recorded behavior differences

The change keeps each reachable behavior. These differences exist only where a double or a callee fails:

- A double for a `void` callback that was `async` and that throws gave a rejection that nothing awaited. After the change it throws at the call site. Each such double is a recorder in a test. A throw from it is a test failure in both forms.
- `renderChat` and `sandboxPull` settle their callers one microtask earlier, because the callers no longer await a Promise. No code reads that timing.

A group that finds a new difference records it in `notes.md` and stops if it is reachable.

### D7: The test strength

A test keeps its strength:

- A test edit does not remove or loosen an `expect` call. The count of `expect(` in the source text of each changed test file stays the same or grows. `notes.md` records the counts.
- The run of the 63 baseline test files after the change gives 0 fail, at least 2183 tests, and at least 7573 `expect()` calls.
- No fix adds a `return Promise.resolve()` to a test callback, and no fix removes an `await` before an `expect(...).rejects` or `.resolves`.

## Risks / Trade-offs

- [A body that the implementor judges safe throws, and the caller hides the sync throw] → D2 lists the known sites, and the rule "when not sure, `Promise.try`" applies. The implementation review reads each throwing double.
- [The lint run of a group shows a shape that the design does not name] → The group applies D1 and D2. It records the shape in `notes.md`.
- [`streamOf` calls in a statement become `must-use-result` reports after #810] → D3 puts the call inside an arrow function. #810 owns the remaining sites.
- [A builder hides a stateful `Response` that a test reads twice] → `respondWith` makes a new `Response` for each call, and its test proves it.
