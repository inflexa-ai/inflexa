# Design

## Context

See proposal.md for the motivation. The finding list is the deferred work of the cli lint stack (#610 to #811 under umbrella #608). No GitHub issue holds it. The facts that shape the approach:

- `cli/oxlint.config.ts:53-59` (`sourceSelector`) matches a dynamic `import()` by `source.value` and by `source.quasis.0.value.cooked`. The selector matches a template literal with an interpolation by its first quasi only, and it does not match a variable or a concatenation. No `import()` in `src/tui/` or `src/client/` has a source that is not written out. `src/client/test/import_boundary.test.ts:126` pins that a template literal with no interpolation is permitted. The plugin helper `@inflexa-ai/oxlint-plugin/helpers/module-sources` uses the same definition: a written-out specifier is a string `Literal` or a `TemplateLiteral` with no expressions.
- `harness/oxlint.config.ts:3-5` says that the pinned 0.7.0 exports no named copy of `js/recommended`. The pin is 0.8.0 (`harness/package.json:116`). The installed 0.8.0 has `eslintRecommended` in `dist/presets.js`, but its `exports` map gives only `.`, `./plugin`, `./helpers/*`, and `./package.json`, and `dist/index.d.ts` exports no named copy. cli gets the set through the `solid()` factory, which applies it to `**/*.{ts,tsx}`.
- The tsgolint panic of the #610 review (`main.go:660`, exit 2, one run of six) has no saved trace. In v7.0.2003, `main.go:660` is `os.Exit(runMain())` in `func main`. It is the bottom frame of each panic in the main goroutine, thus it does not name a rule. 220 cli lint runs, one at a time, on the tip of this branch exit 0 with no `panic` line (`tmp/claude/608-findings/lint-loop/` at the root of the repository). After the pin 7.0.2003, the releases are 7.0.2004 and 7.0.2005. 7.0.2004 fixes a deterministic panic of `no-unsafe-return` on a JSDoc `@callback` with no `@returns`, and 7.0.2005 fixes an infinite loop of `no-deprecated`. No release note names a panic that occurs in some runs only. Upstream issue #1084 reports diagnostics that differ across identical runs, and it is open.
- The `test (cli)` CI job counted 16967 `expect()` calls for #813 at ea61f71f, and 16964 for #814 at 9d440af7. After the rebase of the stack, CI counts 16990 for #813 at 18999aef and 16990 for #814 at 8f3dc802. Linux container runs (Bun 1.4.2, arm64, a user that is not root, `CI=true`, git and python3 installed) gave 16961 and 16960 for the old pair, and 16987 and 16986 for the new pair. A JUnit diff for each test shows one test with a different count in each pair: `startExitIndicator > fits the row it is given, so a frame never wraps and smears down the screen` (`src/lib/test/shutdown.test.ts:94-106`). It calls `expect()` one time for each frame (`:105`). The frames come from a real 80 ms timer (`src/lib/shutdown.ts:16`) in the 140 ms after the 500 ms grace. No other test that uses a real timer loops an `expect()` over the timer output.
- The randomized full runs with the seeds 11, 22, 33, 44, and 55 (`tmp/claude/608-findings/rand/`) each had failures. The causes are in D5.
- `harness/src/execution/run-event-stream.ts:107` types `RunEventStreamDeps.pool` as the `pg` `Pool`. The pool goes only to `queryRun` (`RunRowQuerier`, `harness/src/state/runs.ts:30`) and to `queryStepsByRun` (`StepRowQuerier`, `harness/src/state/step-executions.ts:17`). `Querier` (`harness/src/state/db.ts:17`) is the shared querier type of the harness, and its doc states that a `Pool` and a `PoolClient` satisfy it. The cli stand-in of the route test is a `Querier` already (`cli/src/server/routes/test/runs.test.ts:26`).
- `ArtifactRegistrationInput.collector` (`harness/src/execution/artifact-registry.ts:36`) is the class `ProvenanceCollector` (`harness/src/provenance/collector.ts:170`), which has private members. Thus no object literal satisfies it. The barrel exports it as a type only (`harness/src/index.ts:123`). The input already carries `resourceId`, `runId`, and `stepId` as fields. cli reads `getRecords` (`cli/src/modules/harness/prov_bridge.ts:247`) and `getTrackedInputs` (`:337`) of the collector. The records of `fakeCollector` (`cli/src/test_support/fake_collector.ts:19-23`) omit `outputHash`, `outputSize`, `stepId`, and `runId`, which `ProvenanceRecord` requires (`harness/src/provenance/types.ts:64-82`). The test at `cli/src/modules/harness/test/prov_bridge.test.ts:258-283` gives a command producer with no `durationMs`, which the harness type requires, to prove the guard at `prov_bridge.ts:160-163`. `cli/src/modules/harness/test/run_deps.test.ts:108` gives `fakeCollector()` to a field typed as the class. The seam doc (`artifact-registry.ts:11-12`) names a managed provenance adapter that is not in this repository.
- The fetch doubles of the form `() => Promise.resolve(new Response(...))` are listed in D7. `respondWith(body, init)` (`cli/src/test_support/fake_fetch.ts:16`) gives the same double, with a new `Response` over the same body for each call.
- The doc of `Number.prototype.formatBytes` (`cli/src/extensions/number.ext.ts:12-13`) says that it is "the single place any byte quantity is rendered". `formatIecBytes` (`cli/src/lib/bytes.ts`) renders the package store and rail readouts with IEC labels. Design D12 of the archived change `2026-11-04-adopt-remaining-preset-rules` kept both vocabularies, and `file-picker/spec.md:208` names `Number.formatBytes`.

## Goals / Non-Goals

**Goals:**

- Fix each finding at its cause, or record the evidence where no cause or fix exists (D3).
- `bun run lint`, `bun run typecheck`, and `bun run test` pass in `cli/`. The harness builds, and its lint, its type check, and the affected harness tests pass.
- The cli suite passes in a random order for each seed of the verification set (D5).
- No assertion goes away, and no test gets weaker. The width test of D4 folds its loop of `expect()` calls into one call over the same condition.

**Non-Goals:**

- No change of product behavior, of user-visible text, of a wire format, or of a database schema.
- No new dependency and no version change of a package. No version change of the harness: the developer controls the harness release.
- No change of the handlers that D7 keeps.

## Decisions

### D1: Refuse a dynamic import whose source is not written out

Add one entry to `clientBoundaryBans` of `cli/oxlint.config.ts`. It reports an `ImportExpression` whose source is not a string `Literal` and is not a `TemplateLiteral` with no expressions. One esquery form is `ImportExpression:not([source.type='Literal'][source.value=/^/]):not([source.type='TemplateLiteral'][source.expressions.length=0])`. The regex attribute matches a string value only, thus a number or a boolean literal (`import(42)`) is also refused. The type check refuses such a source too, but the lint entry must obey its spec on its own. If oxlint does not accept that form, use two selectors that mean the same thing. The real lint run of the test decides. The message tells the client to write the path out, because the boundary bans read the path and a computed path escapes them. The entry lives in `clientBoundaryBans`, thus it applies to `src/tui/**` and `src/client/**`, the tests included, and not to the server side.

`sourceSelector` keeps its quasi selector. With the new entry, the first quasi of a permitted template literal is the whole text, thus the comment at `cli/oxlint.config.ts:49-52` must say so. The comment names the entry by what it refuses, not by its position in the list. `cli/CLAUDE.md`, "The client import rule", gets one sentence for the new entry.

`src/client/test/import_boundary.test.ts` gets a case of computed forms in `src/client` and in `src/tui`: an interpolation at the start (`` import(`./${name}.ts`) ``), an interpolation after a permitted prefix (`` import(`../api/${name}.ts`) ``), a variable (`import(path)`), a concatenation (`import("./" + name)`), and a literal that is not a string (`import(42)`). No other ban of the file can match these texts, thus a report proves the new entry. The rule must report each one, one form on each line. A computed form in `src/server` must give no report.

Alternatives: a ban of each `TemplateLiteral` source. It is simpler, but it refuses the written-out template form that the test pins as permitted. The plugin helper also treats that form as written out. Thus it is rejected. A selector over each quasi cannot see a variable or a concatenation, thus it is rejected.

### D2: Correct the comment of the vendored set

The vendored `jsRecommended` of `harness/oxlint.config.ts` stays, because no public path of the plugin gives a named copy of the set. The comment states that fact, and the fact that the factory applies the set to `**/*.{ts,tsx}` only, while the harness scripts are JavaScript. The comment names no plugin version. A version in a comment goes stale at the next pin change, and that is the defect of this finding.

Alternatives: an import of `dist/presets.js` by a deep path. The `exports` map refuses it, thus it is rejected. A bump of the plugin to 0.9.0 is not part of the finding, thus it is rejected.

### D3: Record the tsgolint evidence, and change no version

The panic did not occur again in 220 bounded runs. Its trace was not saved, thus no rule or input is known. No release after 7.0.2003 names a panic that occurs in some runs only. A bump to 7.0.2005 in cli, harness, and prov-kernel (the repository uses the same exact version in each subsystem) cannot be shown to fix the panic, and it changes the reports of some rules. Thus no version changes, and no retry wraps the lint. The PR text records the evidence. If the panic occurs again, save the complete stderr, because the frame above `main.go:660` names the rule.

### D4: Assert the frames of the exit indicator in one call

In `src/lib/test/shutdown.test.ts`, the width test replaces `for (const frame of drawn) expect(frame.length).toBeLessThanOrEqual(11)` with one assertion over the whole list, for example `expect(drawn.filter((frame) => frame.length > 11)).toEqual([])`. The `drawn.length > 0` assertion stays. The test then makes the same number of `expect()` calls on each run. The condition is the same, and a failure names each frame that is too wide, thus the test is not weaker.

The count of this test is 1 plus the number of frames, and the number of frames depends on the timer schedule of the machine. In the Linux container, this test is the only per-test difference in each pair, and no difference depends on the platform or on the move. CI gives no count for each test, thus the CI difference of 3 is attributed to this test by inference, not by a per-test measure. A fake clock is rejected: the comment of the file states that the real timers are the contract of the test. A guard for Linux is rejected, because no cause depends on the platform.

### D5: Make each order-dependent test set and restore its own state

The randomized runs found these causes. Each fix makes the test independent, and no fix removes an assertion.

- `src/modules/update/test/notice.test.ts:16` and `:27` define `process.stderr.isTTY` as `{ value, configurable: true }`, which is not writable. The restore at `:27` defines an own property also where the stream had none. After that file, the plain assignment of `isTTY` in `src/lib/test/shutdown.test.ts:32`, `:41`, and `:83` throws, and each test of that file fails.
- `src/modules/harness/test/runtime.test.ts:265-269`: the file-level `afterEach` calls `rmSync(skillsDir, ...)`, and only `testConfig()` (`:68-70`) sets `skillsDir`. A test that runs before each call of `testConfig()` fails in the hook. The hook must remove the folder of the test only when the test made one.
- `src/modules/infra/test/setup.test.ts:2097` and `:2111` write `env.configPath` with no parent folder, thus they fail when no earlier test made the folder. The tests must make the folder, for example with the `seedConfig` helper of the file (`:632-635`) when it is in scope.
- `src/modules/infra/test/setup.test.ts:1714` (`--no-auth refuses an answered cliproxy provider rather than dropping it`) reached a clack prompt with `setRawMode` undefined under seed 22, after `:1710` sets `process.stdin.isTTY`. The cause: a failed `setup()` run writes the checkpoint file `env.setupStatePath` (`src/modules/infra/setup.ts:175-183`), and an interactive run that reads one at `setup.ts:322-323` asks `offerContinue` (a clack `select`) before the refusal under test. The `beforeEach` and `afterEach` of the `setup() — batch orchestration` block removed the config files but not the checkpoint, so an earlier test that left one made `:1714` reach the prompt (seed 22 reproduces it when the removal is taken out). Both hooks now remove `env.setupStatePath`.
- `src/modules/analysis/test/analysis.test.ts:165-179`: a `farms` folder that an earlier test left in the sandboxed store makes the write of the blocking file fail with EISDIR. The block clears the store root only in its `afterEach`. It must also clear it before each test.

The randomized run with the seed 88, after the first implementation, found these causes too:

- `src/tui/test/switch_analysis_picker.render.test.tsx:272` raises the "Copied analysis id" notice, and its cleanup (`:45`) does not clear the notice store. The notice stays with its real dismiss timer. `src/tui/hooks/test/notice.test.ts` and `src/tui/hooks/test/run_completion.test.ts` reset the notice store, the sidebar store, and the run completion store only in an `afterEach`, thus a test that runs first in the file reads the notice of the picker. The ordered pair `bun test ./src/tui/test/switch_analysis_picker.render.test.tsx ./src/tui/hooks/test/run_completion.test.ts` reproduces a failure of the notice queue test. The picker test must clear the notice store in its cleanup, and each of the two hook test files must also reset the stores that it reads before each test: the notice store for `notice.test.ts`, and the notice, sidebar, and run completion stores for `run_completion.test.ts`.
- `src/tui/hooks/test/run_completion.test.ts` and `src/tui/hooks/test/activity_panel.test.ts` run each body in `createRoot(async (dispose) => { ...; dispose(); })`. When an assertion fails, `dispose()` does not run, and the watcher of the root stays alive. A live watcher shares the module sets of `src/tui/hooks/run_completion.ts` (`seenActive`, `openReads`), and it takes the read of each later test, thus one failure makes each later test of the block fail with no reads. `src/test_support/solid.ts` has `withRoot`, which disposes in a `finally`, but for a synchronous body only. An async twin beside it disposes the root after the body settles, and each `createRoot(async (dispose) => ...)` site of the two files uses it.

The stdio helper:

- `replaceProperty(target, key, value)` in `src/test_support/replace_property.ts` replaces one property of an object until the end of the current test. It must be called inside a test or a `beforeEach`.
- At the first replacement of a key of an object in a test, it keeps the own descriptor that the object had, or the fact that it had none. It registers one restore through `onTestFinished` of `bun:test`. A later replacement of the same key in the same test only defines the new value, thus the restore always gives back the state from before the test, whatever the order of the restores.
- It defines the new value as a configurable and writable data property. The restore defines the saved descriptor again, or deletes the own property when there was none.
- The registration of the restore is an options parameter of the helper, with `onTestFinished` as its default. The test of the helper gives its own function, calls the restore itself, and then asserts the state. Thus the test of the helper does not depend on the order of the tests.
- Thus no test file keeps a list of restores, an `afterEach` for them, or a `try`/`finally` for a property. A test that must restore before its end has no such site in the tree.
- Each test that replaces a property of `process.stderr` or `process.stdin` uses it, `write` included. The sites are `src/lib/test/shutdown.test.ts`, `src/modules/update/test/notice.test.ts`, `src/lib/test/cli.test.ts`, `src/modules/infra/test/setup.test.ts` (the `--no-auth` test, the interactive block, and the checkpoint block), and `src/modules/embedding/test/setup.test.ts` (`withTTY`).
- `src/lib/test/shutdown.test.ts` and `src/modules/update/test/notice.test.ts` capture stderr the same way: a faked `isTTY` and a `write` that collects each chunk. One shared helper in `src/test_support/` gives that capture, and the two files use it.
- Bun 1.4.2 has no `jest.replaceProperty` (a probe gave `undefined`), and its `onTestFinished` runs the callbacks of a test in the order of registration (a probe showed it), thus the helper is local and keeps one restore for each key.
- The test of the helper is the deterministic proof of the stdio fix: after the restore, the object has its original descriptor (or none), and a plain assignment of the property works. It covers an own writable property, no own property, a getter of the prototype, and two replacements of one key. The randomized seeds are more evidence, because a seed does not fix the order of two files.

The two `writeFileSync(env.configPath, ...)` sites of `setup.test.ts` that make the config folder first use one `seedConfig` helper with the existing helper at `:632-635`, moved to the scope of the file.

Verification: the coordinator runs `bun test --randomize` in `cli/` for the seeds 804, 11, 22, 33, 44, 55, 66, 77, 88, and 99, one run at a time. This is the verification set of the spec. A new failure in a seed is a correction of this change.

Alternatives: a fix of `notice.test.ts` only. It removes the known break, but `shutdown.test.ts` still depends on a writable `isTTY`, and the stdin sites keep the same leak. Thus it is rejected. A `--randomize` flag in CI is a new CI policy, thus it is out of scope.

### D6: Type the harness pool by what it reads, and keep the collector cast

`RunEventStreamDeps.pool` gets the type `Querier` of `harness/src/state/db.ts`. A `Pool` satisfies it, thus each caller of `createRunEventStream` still compiles: the change widens the parameter. `Querier` is the shared querier type of the harness. A third spelling, such as `RunRowQuerier & StepRowQuerier`, is rejected.

In cli, `asHarnessPool`, its `SAFETY` comment, its directive, and the `Pool` import of `src/server/routes/test/runs.test.ts` (if nothing else reads it) go away. The test passes its stand-in directly.

The collector keeps its class type, and `fakeCollector` keeps its cast and its `SAFETY` comment, which is true. A structural type does not remove the cast, for these reasons:

- The records of the fake omit fields that `ProvenanceRecord` requires and that the adapter does not read. A typed fake must give a value for each of them.
- The test of a command producer with no `durationMs` (`prov_bridge.test.ts:258-283`) gives a record that the harness type does not permit. It proves the guard of the adapter for a record with no duration, thus it must keep a cast at its site.
- `run_deps.test.ts:108` gives the fake to a field that the class types, thus it must change too.

The finding asks for the collector type only "if that is a small change". It is not, thus the harness collector type does not change.

Alternatives for the collector:

- A `Pick` of `getRecords` and `getTrackedInputs` for `ArtifactRegistrationInput.collector`. It narrows a seam input that a realization outside this repository can read, and it moves the cast to a test and to typed defaults instead of removing it. Rejected.
- A `Pick` of each public member of the class. The fake must then carry the record methods that a registration must not call, and the same casts stay. Rejected.

### D7: Use `respondWith` for each constant promise double

The sites are:

- `src/client/test/api.test.ts:99`
- `src/tui/test/app_config.render.test.tsx:555`
- `src/modules/proxy/test/models.test.ts:404`, `:409-417`, `:421`, and `:431`
- `src/modules/infra/test/setup.test.ts:2176` and `:2704`
- `src/modules/harness/test/model_listing.test.ts:277` and `:293`

Each becomes `respondWith(body, init)` with the same body and init. A run of the tests then gives the same `Response` for each call. The one difference: `respondWith` changes a throw of the `Response` constructor into a rejection. No site gives a status that the constructor refuses.

`src/client/test/api.test.ts:222-226` stays. Its body is a `ReadableStream` that `chunked(...)` makes in each call. `respondWith` makes the body one time, and a stream body reads one time only, thus a second call would get a used stream.

These forms also stay, because they are not the form of the finding:

- A handler that takes arguments or decides on them, and gives `Promise.resolve(new Response(...))` (for example `src/client/commands/test/runs.test.ts:26`, `src/modules/harness/test/model_listing.test.ts:640`, `src/modules/libs/test/store_download.test.ts:186`).
- A handler that returns a `Response` with no promise, to a fake router or an engine stub that awaits it (for example `routeFetch` in `src/modules/infra/test/setup.test.ts`, `withFetch` in `src/client/test/conversation.test.ts`, `stubOnce` in `src/modules/proxy/test/models.test.ts`, and `fakeEngine` in `src/lib/test/container.test.ts`). Many of them use `Response.json`, which `respondWith` has no form for.

The proof is the multi-line search `rg -nU '\(\)\s*=>\s*Promise\.resolve\(\s*new Response' src` in `cli/`, which finds only `src/client/test/api.test.ts:222`.

### D8: Make the byte formatter doc true, and keep both vocabularies

The doc of `Number.prototype.formatBytes` keeps its reason for the short labels and its clamp. The claim "the single place any byte quantity is rendered" becomes: the one formatter of the short labels, while the package store and rail readouts use `formatIecBytes` (`src/lib/bytes.ts`) with IEC labels. No text that a user sees changes.

The alternative moves the store and rail readouts to `formatBytes`. It changes their labels from `KiB` to `KB` and their rounding, which is a change of user-visible text, and design D12 of `2026-11-04-adopt-remaining-preset-rules` rejected it. Thus it is rejected.

## Behavior changes

None in the product. The lint refuses one more form in the client folders (D1), and no site in the tree has that form.

## Risks / Trade-offs

- [oxlint does not accept the new selector form] → The test lints real snippets with the real configuration. A selector that oxlint refuses, or that matches nothing, fails it. D1 names a second form.
- [A randomized seed outside the verification set finds a new order dependence] → The spec covers the verification set. The design records the seeds, and a later failure is a defect of that test.
- [The panic occurs again in CI] → D3 tells what to save, so that the next occurrence names its rule.

## The reviewer record

The artifact audit had the coordinator, Codex, Pi, and a Claude reviewer. The Claude reviewer voted on each decision. Codex and Pi audited the artifacts, and they raised no finding against D1, D3, D5, the pool part of D6, or D8.

| Decision | Claude reviewer | Codex | Pi | Coordinator | Result |
|-|-|-|-|-|-|
| D1 | agree: the pinned template form and the plugin helper agree | no finding | no finding | agree | kept |
| D3 | agree: one pin in each subsystem, no release names the panic | no finding | no finding | agree | kept |
| D5 | agree: the same leak repeats at each stdio site | no finding | no finding | agree | kept |
| D6 pool | agree: `Querier`, the stand-in is one already | no finding | no finding | agree | kept |
| D6 collector | agree with the `Pick` of two members | blocked it: the fake records are incomplete, and `run_deps.test.ts:108` needs the class | no finding | changed to keep the cast | the cast stays (evidence in D6) |
| D7 | agree with the scope, but the site list missed the multi-line sites | the proof search also matches the kept handlers | the same as Codex | agree with both | the list and the proof are corrected |
| D8 | agree: doc only, D12 of the earlier change rejected the label change | no finding | no finding | agree | kept |

The D6 collector result goes against the first vote of the Claude reviewer. The evidence of Codex shows that no structural type removes the cast, thus the condition of the finding ("if that is a small change") is false.
