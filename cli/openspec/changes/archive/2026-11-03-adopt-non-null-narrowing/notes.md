# Notes

## Measurements

### Report counts

Measured on `a2a99f23` with the three rules forced on (scratch config `tmp/claude/807/807-probe.json`, oxlint 1.85.0):

| Rule | Sites | Tests | Source |
| --- | --- | --- | --- |
| `typescript/no-non-null-assertion` | 626 | 488 | 138 |
| `typescript/no-unnecessary-condition` | 50 | 12 | 38 |
| `typescript/no-unnecessary-type-assertion` | 6 | 4 | 2 |

### Benchmark of design D4

Script: `tmp/claude/807/bench.ts` (scratch, not in the repository). Machine: Apple M3 Pro, Bun 1.4.2. Each measurement runs 3 warm-up calls and then 15 timed calls, and the table gives the median. The baseline runs before the first edit of `search_index.ts`, `walk_child.ts`, and `fuzzy.ts`.

Inputs:

- `NameIndex`: 1,000,000 entries added through `add` (fan-out 8 parent tree, 12 ASCII stems, a `.txt` suffix on every fifth name, a hidden name on every 97th, every fourth entry a folder). `rank` takes a limit of 50, an ASCII query of one letter (`a`) and of three letters (`rep`).
- `decodeRecords`: a stream of 1,000,000 entry records (21,115,870 bytes) of the same names, fed as 64 KiB chunks that cut records (they use the carry buffer). One measurement uses a sink that counts. One measurement ingests each entry through `NameIndex.addBytes`.

Baseline, three separate processes (median of 15 calls, in milliseconds):

| Measurement | Process 1 | Process 2 | Process 3 | Baseline (median of the three) |
| --- | --- | --- | --- | --- |
| `rank`, 1 letter | 12.92 | 12.68 | 12.28 | 12.68 |
| `rank`, 3 letters | 20.40 | 19.80 | 18.63 | 19.80 |
| `decodeRecords`, count sink | 8.47 | 8.11 | 8.42 | 8.42 |
| `decodeRecords` into `addBytes` | 26.74 | 27.50 | 26.58 | 26.74 |

The raw output is in `tmp/claude/807/bench-baseline-{1,2,3}.txt`.

After task 2.1, three separate processes (median of 15 calls, in milliseconds). The gate of design D4 is a growth of 10% or less:

| Measurement | Process 1 | Process 2 | Process 3 | After (median of the three) | Baseline | Change |
| --- | --- | --- | --- | --- | --- | --- |
| `rank`, 1 letter | 13.37 | 13.57 | 13.34 | 13.37 | 12.68 | +5.4% |
| `rank`, 3 letters | 20.13 | 19.76 | 19.24 | 19.76 | 19.80 | -0.2% |
| `decodeRecords`, count sink | 4.68 | 4.69 | 4.71 | 4.69 | 8.42 | -44.3% |
| `decodeRecords` into `addBytes` | 27.06 | 26.14 | 26.79 | 26.79 | 26.74 | +0.2% |

No median grows by more than 10%, thus the inline fallback of design D4 did not apply. The raw output is in `tmp/claude/807/bench-after-{1,2,3}.txt`.

## Invariant reads

Each call passes a constant string as the description, thus the call allocates nothing on the hot path.

| Site | Description | Invariant |
| --- | --- | --- |
| `src/modules/fs/search_index.ts` `NameIndex.depthOf` | `the depth of an entry` | `i` is below `count`: the caller holds a hit index from `rank`, a parent from the parent chain, or a folder index from the walk stack. |
| `NameIndex.flagsAt`, `startAt`, `lengthAt`, `parentAt` | `the flags of an entry`, `the start of a name`, `the length of a name`, `the parent of an entry` | Same bound as `depthOf`: `i` is below `count`, and `grow` keeps each parallel array at one length. |
| `NameIndex.chunkAt` | `the chunk of a name` | `add` wrote each start with the index of a chunk that it pushed. |
| `NameIndex.addBytes` copy loop | `a byte of a name` | The caller gives a name of `length` bytes inside `bytes`. |
| `NameIndex.compareNames` byte loop | `a byte of a name` | `k` is below the shorter of the two lengths, and each name lies inside its chunk. |
| `slot` of the heap in `rank`, `siftUp`, `siftDown`, `swap` | `a heap slot` | Each position is below `size`, and `size` is at most `limit`, the length of the heap arrays. |
| `src/modules/fs/walk_child.ts` `pump` (three stack pops) | `the folder index at the top of the walk stack`, `the path at the top of the walk stack`, `the depth at the top of the walk stack` | The three stacks have the same length, and the loop condition holds a non-empty stack. |
| `src/lib/fuzzy.ts` `subsequenceScoreBytes` | `a byte of a name`, `a byte of the query` | `ti` is below `end`, which the caller bounds by the array, and `qi` is below `queryLength`. |
| `src/server/routes/analyses.ts` `GET /` (the list handler) | `the summary of an analysis` | `summarizePage` maps `ids` and gives one summary for each id, in order. The page items and `ids` come from the same list. |
| `src/server/routes/analyses.ts` `summarizePage` | `the folder state of an analysis` | `existenceOf` maps `anchorPaths` and gives one boolean for each path. `anchorPaths` and `ids` come from the same page. |
| `src/server/routes/analyses.ts` `existenceOf` | `the existence of an anchor path` | `pathsExist` gives one boolean for each path that it got, in order, and `next` walks the non-null paths. |
| `src/server/routes/fs.ts` `GET /search` | `the view of a search hit` | `enrichEntries` gives one view for each entry, in the order of the entries. |
| `scripts/build.ts` audience check (two reads) | `INFLEXA_AUTH0_AUDIENCE`, `INFLEXA_AUTH0_DOMAIN` | The missing-variable loop above exits on an absent name, and it covers the two names only while `src/lib/env.ts` bakes them. A build script is an entry point, thus the throw ends the build. |
| `src/cli/index.ts` `renderEnvHelp` table | `the width of a help column` | The loop above fills a width for each column index of each row, thus each cell finds its width. |

## Condition census

| Site | Class | Fix | Evidence |
| --- | --- | --- | --- |
| `src/modules/fs/search_index.ts` `waitForWalk` (`if (!cached.hasStarted) return` after the wait) | A guard on a flag that a closure sets (`begin` sets `hasStarted` while the call waits) | Device 3: the read follows the wait in `startedWithin`, a function that holds no narrowing of the call site. No directive. | The report named the second `cached.hasStarted` test as always truthy, because the first test narrowed the property to `false`. |
| `src/modules/infra/compose.ts` `sum + (size ?? 0)` | Dead guard (a value that a library guarantees) | Deleted the `?? 0`. | `sizes.every((size) => size !== null)` is a type predicate that TypeScript infers (5.5 and later), thus `sizes` is `number[]` in the true branch and `size` is `number`. |
| `src/lib/cause.ts` `safeStringify` (`json ?? String(value)`) | Value from outside the program (`JSON.stringify` gives `undefined` for a function, a symbol, or `undefined`) | Kept the guard. `stringifyOnce` has the declared return type `string \| undefined`. | The call site now reads the declared type, and an initialized local does not clear the report. |
| `src/lib/shutdown.ts` exit indicator (`process.stderr.columns ?? INDICATOR_FALLBACK_COLUMNS`) | Value from outside the program (a stream with no terminal size has no `columns`) | Kept the guard. `columnsOf` takes `{ readonly columns?: number }`. | The Bun type of `process.stderr` gives `columns: number`, which hides the absent case. The parameter type shows it. |
| `src/lib/container.ts` `pullImageThroughEngine` (`failure`) | Guard on a flag that a closure sets (`consume`) | Device 1: `let failure: string \| undefined;` and the tests on `undefined`. | The report cleared. |
| `src/tui/keymap.ts` `leaderTimeoutMs` (`?? 2000`) | Dead guard (a value that the program parsed) | Deleted the `?? 2000`. | `src/lib/config.ts` gives `leaderTimeout` `.catch(2000).default(2000)`, thus `readConfig().leaderTimeout` is `number`. |
| `src/tui/keymap.ts` `armTimer` (`unref?.()`) | Dead guard (a library guarantees it) | Deleted the `?.`. | The type of `setTimeout` in Bun types has `unref`, and the keymap tests pass. |
| `src/tui/hooks/prompt_recall.ts` (two `position !== null`) | Dead guard (the types show it) | Deleted both tests, and corrected the comment of the second. | `inRecall` is a `const` condition that includes `position !== null`, and TypeScript narrows `position` through the aliased condition, also inside the closure `step` (`position` is a `const`). |
| `src/modules/prov/prov.ts` `runFlush` (`while (flushRequested)`) | Guard on a flag that another function sets (`scheduleFlush` sets it while the pass awaits) | Device 3 (a derived read): `flushWasRequested()` has the declared return type `boolean`. | The assignment `flushRequested = false` at the top of the pass narrowed the module variable to `false`. Device 1 does not apply, because the assignment, not the initializer, narrows it. |
| `src/modules/staging/staging.ts` `stageDest` (`failed`) | Guard on a flag that concurrent calls set | Device 3: `hasFailed()` is an arrow function that reads the flag. | The test `if (failed) return null` narrowed `failed` to `false` for the rest of the function, also across the `await`. |
| `src/modules/staging/staging.ts` `isInputSetMaterialized` (`mismatch`) | Guard on a flag that a closure sets | Device 1: `let mismatch: boolean \| undefined;`. | The report cleared. |
| `src/modules/embedding/local-provider.ts` `drainStderrTail` (`!value`) | Dead guard (a library guarantees it) | Deleted `!value \|\|`. The `value.length === 0` test stays. | After `if (done) break`, `ReadableStreamReadResult` narrows `value` to `Uint8Array`. |
| `src/modules/libs/store_download.ts` `runCatalogTransfer` (`totalBytes`) | Guard on a flag that a closure sets | Device 1: `let totalBytes: number \| undefined;`. | The report cleared. |
| `src/modules/harness/inflexa_tool.ts` `spawnInflexa` (`killTimer`, `timedOut`) | Guard on a flag that a closure sets (`escalate`, `expire`) | Device 1 for both: `let killTimer: ... \| undefined;` and `let timedOut: boolean \| undefined;`. | The report cleared. |
| `src/modules/harness/inflexa_tool.ts` `store add` (`scoped.kind === "analysis"`) and `cwd` (`scope.kind === "analysis"`) | Guard on the one-member `Scope` | Deleted the guards and read `scoped.analysisId`, `scope.analysisId`. | `Scope` has the member `kind: "analysis"` only (`harness/src/auth/types.ts:34-38`). The test `inflexa_tool.test.ts:729-736` passes unchanged. |
| `src/modules/harness/inputs_tool.ts` `changedPaths`, `execute`; `src/modules/harness/launch_dir_tool.ts` `execute` (`resourceType !== "analysis"`) | Guard on the one-member `Scope` | Deleted the guards and read `scopeResource(scope).resourceId`. The `no_analysis` status stays through the vanished-row path. | `scopeResource` always gives `resourceType: "analysis"` (`harness/src/auth/types.ts:78-80`). The test `launch_dir_tool.test.ts:72-84` passes unchanged. |
| `src/modules/harness/usage_recorder.ts` `scopeColumns` | Guard on the one-member `Scope` | The function reads the scope directly and gives `ScopeColumns`. The `null` arm and the `err` import of the caller went. | The `switch` over the single kind was constant. A new `Scope` variant now fails to compile at the read. No test covered the arm. |
| `src/modules/harness/prov_bridge.ts` `toCommandRef` (`producer.durationMs !== undefined`) | Value from outside the program (live guard) | Kept the guard. `setDuration` takes `{ readonly durationMs?: number }`. | The first attempt deleted the guard. The test "a command carries args, durationMs, and scriptPath as keys only when the collector captured them" failed on it, thus the guard is live although the harness type (`CommandProducerSchema`) requires the field. |
| `src/modules/harness/dev/run.ts` (`s.depends_on ?? []`) | Dead guard (a value that the program parsed) | Deleted the `?? []`. | The type of `depends_on` of a plan step is not optional, and the typecheck passes. |
| `src/modules/harness/dev/chat.ts` `formatTable` (`c ?? ""`) | Dead guard | Deleted the `?? ""` of `c`. The `widths[ci] ?? 0` on the same line stays. | `c` is a `string` from `string[]`, and `widths[ci]` is an index read under `noUncheckedIndexedAccess`. |
| `src/modules/harness/dev/chat.ts` `runTurn` (`aborting`, `forceStop`, three tests) | Guard on a flag that a closure sets (`onSigint`) | Device 1 for both: `let aborting: boolean \| undefined;`, `let forceStop: boolean \| undefined;`. | The report cleared. |
| `src/modules/infra/setup.ts` (`value !== undefined` of `strandedByNoPostgres` and of `anyAnswered`) | Value from outside the program (live guard: an answer block carries each field, an unanswered one as `undefined`) | Kept the guard. `answeredFields` takes `Readonly<Record<string, unknown>> \| undefined`. | The type of `Object.entries` over an object of optional fields drops `undefined`. |
| `src/modules/infra/setup.ts` `scanStream` (`while (true)`) | Constant loop condition | Device 2: `for (;;)`. | The report cleared. |
| `src/modules/infra/setup.ts` `runProviderLogin` (`code !== null`) | Dead guard (a library guarantees it) | Deleted `&& code !== null`. | Bun types `exited` as `Promise<number>` (`node_modules/bun-types/bun.d.ts:7958`). A probe on Bun 1.4.2 gave `137` for a `SIGKILL` exit, with `exitCode` `null`. |
| `src/modules/infra/setup_answers.ts` `answersNothing` (`answer === undefined`) | Dead guard (a value that the program parsed) | Deleted the line. The `leaf === undefined` test stays. | The argument is the zod parse of a YAML document, which holds no `undefined` value. The tests of `setup_answers` pass. |
| `src/modules/infra/setup_answers.ts` `resolveSetupAnswers` (`merged as SetupAnswers`) | Unnecessary type assertion | Removed the `as` and the `SAFETY` comment that justified it. | The report named the receiver as accepting the original type, and the typecheck passes. |
| `src/modules/prov/lineage.ts` `activityJsonNode` (`facts as LineageJsonNode`) | Unnecessary type assertion | Removed the `as` and the `SAFETY` comment that justified it. | The same, and the typecheck passes. |
| `src/server/profile_queue.ts` `schedule` (`handle.unref?.()`) | Dead guard (a library guarantees it) | Deleted the `?.`. | The Bun type of `setTimeout` has `unref`. The profile queue tests pass. |
| `src/server/routes/files.ts` `OPEN_FLAGS` (two `?? 0`) | Value from outside the program (a platform without the flag) | Kept both guards. `platformFlag` takes `number \| undefined`. | The Node types give `number` for `constants.O_NOFOLLOW` and `constants.O_NONBLOCK`, also on Windows. |
| `src/server/routes/report_pages.ts` (`c.req.param("threadId") ?? ""`) | Dead guard (a library guarantees it) | Deleted the `?? ""`. The `analysisId` read on the line above has no report and stays. | The route declares `:threadId`, and Hono types the param `string`. |
| `src/modules/harness/test/agent_switch.test.ts` `lastStepModel` (`step.type !== "prov.step_completed"`) | Test condition: dead guard (a type that the compiler infers) | Deleted the second operand. The `step === undefined` test stays. | The arrow `(e) => e.type === "prov.step_completed"` is an inferred type predicate, thus `find` gives the step event or `undefined`. |
| `src/modules/harness/test/prov_bridge.test.ts` (three `ref.kind !== "command"` guards, on `cmds[0]`, `commandEvents()[1]`, `commandEvents()[0]`) | Test condition: dead guard that throws on a wrong shape | Deleted the three guard lines. | `commandEvents()` returns events of `prov.command_executed`, and the `command` field has the type `ProvCommandRef`, whose `kind` is `"command"`. The typecheck passes and each `expect` stays. |
| `src/modules/harness/test/prov_bridge.test.ts` (`e.type === "prov.file_written" ? e.file.path : ""` and the `prov.input_used` twin) | Test condition: dead ternary over a filtered list | Read `e.file.path` and `e.input.path` directly. The `""` branch went. | `captured.filter((e) => e.type === ...)` is an inferred type predicate. The `toEqual` on the two paths still fails for a wrong event. |
| `src/modules/infra/test/proxy_config.test.ts` (`!created[0].created`) | Test condition: dead operand | Deleted the operand. The `created.length !== 1` operand stays. | `outcomes.filter((outcome) => outcome.created)` narrows to the created variant, thus `created[0].apiKey` types without the guard. |
| `src/modules/prov/test/lineage.test.ts` (`file.kind === "file"` and `activity.kind === "activity"` after `find`) | Test condition: dead `if` that made the `expect` conditional | Removed the `if`. The `expect` runs always. | The `find` predicate narrows the candidate. The test is stronger, because the `expect` can no longer be skipped. |
| `src/modules/harness/test/profile_trigger.test.ts` `capturedParams` | Test flag that a closure sets (`present` read the initializer type `null`) | Device 1: `let capturedParams: DataProfileTriggerParams \| undefined;`. The guard `.not.toBeNull()` became `.toBeDefined()`. | Same strength: the variable held `null` or the params before, and it holds `undefined` or the params now. |
| `src/modules/prov/test/prov.test.ts` (`computeChainHash(first!.chainHash!, ...)`, the `no-unnecessary-type-assertion` report) | Unnecessary type assertion (a non-null assertion on a value that the type already gives) | The `!` became `present(...)` like each other test `!`. | The assertion was the inner `!` of a chain. No `as` was present in the scope. |
| `src/lib/test/download.test.ts` (`e.type === "bytes" ? e.bytes : 0` in the `reduce` after `filter`) | Test condition: dead ternary over a filtered list | Read `e.bytes` directly. The `0` branch went. | `events.filter((e) => e.type === "bytes")` is an inferred type predicate. The `toBe` on the sum still fails for a wrong event. |
| `src/tui/hooks/test/conversation.interrupt_retract.test.ts` (`p.type === "tool-call" ? p.outcome : null` in `calls.map`) | Test condition: dead ternary over a filtered list | Read `p.outcome` directly. | `messages[0]?.parts.filter((p) => p.type === "tool-call")` is an inferred type predicate. The `toEqual(["incomplete", "denied"])` stays. The `calls[0]?.type === "tool-call"` read stays, because `calls[0]` can be `undefined`. |
| `src/tui/layout/test/sidebar.render.test.tsx` (`span.fg &&` before `.equals(span.fg)`) | Test condition: dead operand (a type that a library guarantees) | Deleted the operand. | `CapturedSpan.fg` has the type `RGBA` (`node_modules/@opentui/core/types.d.ts:160-166`), and the other span tests read `span.fg` with no guard. |
| `src/tui/components/dialog/test/usage_dialog.test.ts` (`at[1]!`), `src/tui/hooks/test/sidebar_live.test.ts` (`carried!`, `runsOnly!` as the argument of `toBe` and `toEqual`) | Unnecessary type assertion (the matcher accepts the original type) | The `!` became `present(...)`, like each other test `!`. | The report named the receiver as accepting the original type. `present` can only fail where the value is absent, and the tests pass. |
| `src/tui/components/dialog/test/dialog_host.render.test.tsx`, `src/tui/components/test/ask_prompt.render.test.tsx`, `src/tui/components/test/pause_prompt.render.test.tsx` (`box`, `ta`, `probeInput`) | Test flag that a closure sets (`present` read the initializer type `null`, typecheck gave `TS2531`) | Device 1: `let box: BoxRenderable \| undefined;` and the same for `ta` and `probeInput`. | No test compared these variables with `null`, thus no matcher changed. |
| `src/server/routes/test/conversation.test.ts` "a turn id that the registry does not hold, or of a different thread, gives 404" | Test whose `!` hid an absent value | `present(response.headers.get(TURN_ID_HEADER))` threw, because the default fake `runTurn` never calls `onOpened`, thus the route gave a JSON refusal with no header. The test now gives `runTurn` that calls `onOpened`. | Before, `turnId` was `null` and the last request went to `/turns/null`, which gave 404 for the wrong reason. Now the turn opens, and the 404 is the different-thread check that the test names. No `expect` call changed. |

## Directives

None. Each closure flag cleared through a device: device 1 (drop the initializer and annotate), device 2 (`for (;;)`), or device 3 (a derived read).

## Behavior differences

| Site | Before | After |
| --- | --- | --- |
| `NameIndex.commit` depth of the parent | `this.depths[parent]! + 1` stores 0 (`NaN` from `undefined`) when `parent` is past the capacity of the array. | `depthOf(parent)` throws `the depth of an entry is absent`. Each caller gives an earlier entry (`add`) or a parent that the sink checked against `count` (`addBytes`), thus the path is unreachable. |
| `decodeRecords` header reads | A read past the end of the chunk gives `undefined`, which flows on as 0. | A `DataView` read past the end throws `RangeError`. The loop keeps each read below the length of the chunk or of the carry, and `recordSize` waits for a whole header, thus the path is unreachable. |
| `NameIndex` byte, heap, and chunk reads | A broken bound flows on an `undefined` operand. | `present` throws an `Error` that names the read. |
| `rankBy` loop | Index loop with `items[i]!`. | `items.entries()`, with the same order and the same result. |
| `src/tui/app.tsx` `handleSubmit` | `textareaRef!` after the early `if (!text) return`. | The handler reads `textareaRef` one time into `composer` and returns when it is `null`. The ref cannot change between the read and the use, because no `await` lies between them. |
| `src/tui/app.tsx` `answer` case | `head!.askId` throws a `TypeError` when `head` is `null`. | The case returns when `head` is `null`. `askSubmitAction` gives `answer` only for a docked ask, thus the path is unreachable. |
| `src/tui/components/welcome.tsx`, `error_block.tsx` | `<Show when={props.hints?.length}>`, then `props.hints!`. | `<Show when={props.hints?.length ? props.hints : undefined} keyed>` gives the array to the callback. The same lines show for the same input. |
| `src/tui/hooks/conversation.ts` `spliceRetractedTurn` | Index loop with `msgs[i]!`. | `flatMap` collects the matching indexes, and the splice runs from the highest index. The same messages go. |
| `src/tui/hooks/asks.ts` `activeAsk` | `asks.length > 0 ? asks[0]! : null`. | `asks[0] ?? null`. The same value. The read tracks the first element and not the length. |
| `src/tui/app_config.tsx` | A toggle section holds `settingIndex`, and `settings[index]!` gives the key. A navigation key on an absent section throws. | A toggle section holds the `key`. A handler that finds no section returns. The `Endpoint` line shows with no `Show`, because `setting.key` has the type `"telemetry"` only. A second boolean setting would show the line too. |
| `src/tui/keymap.ts` | `seq[i]!` and `seq[prefix.length]!` pass an absent chord on. | `isPrefix` gives `false` for an absent chord, and the next-key listing skips it. The bounds make both paths unreachable. |
| `src/tui/components/dialog/*.tsx` (`dialog_host`, `export_options_dialog`, `file_picker`, `usage_dialog`) | `stack[stack.length - 1]!`, `keys[...]!`, `reads[i]!`, `cells[i]!` pass an absent value on or throw. | Each read narrows through an `undefined` test or an iterator, with the result that the code gave on the reachable paths. `readEntries` gives each read with its entry, and its workers pull entries from one shared iterator. |
| `src/lib/shutdown.ts` exit indicator | `GLYPHS.spinner[...]!` in the timer. | The tick returns when the glyph is absent. The index is in range, thus the path is unreachable. |
| `src/server/routes/analyses.ts`, `src/server/routes/fs.ts` | A broken pairing of an item and its summary, folder state, or view flows on as `undefined`. | `present` throws, and Hono answers 500. Each pairing holds by construction. |
| `src/server/routes/analyses.ts` busy gate (rename, delete) | `busy[0]!` after `busy.length > 0`. | A destructure and an `undefined` test. The same message. |
| `src/modules/anchor/backstop.ts`, `src/server/routes/anchors.ts` | `e.reasons[0]!`. | `PruneError` `busy` holds `reasons: [BusyReason, ...BusyReason[]]`, and `reclaimDeadAnchors` builds it from a non-empty answer. The message is the same. |
| `src/modules/prov/lineage.ts` `resolveLineageRef` | `byPrefix[0]!`, `matches[0]!`, `byIdentifier[0]!` after a length test. | A destructure of the first two elements. The same branch for the same list. |
| `src/modules/infra/setup.ts` `selectDefaultModel`, `sweepAccessibleModels`, `offerAdoption` | `models[0]!`, `ranked[i]!`, `adoptable[0]!`. | The empty-list branch is the first-element test. The sweep pulls ids from one shared iterator. `offerAdoption` returns `null` (manual entry) for an empty list, which the caller never gives. |
| `src/modules/proxy/models.ts` `resolveModelId` | `ranked[0]!` after the loop. | `resolveModelId` returns `no_models` when the ranked list is empty, and `electModel` takes the top id as an argument. The empty list cannot reach it, because the list of candidates is non-empty. |
| `src/modules/infra/setup_answers.ts`, `src/lib/credential.ts`, `src/modules/libs/store.ts`, `src/modules/embedding/llama_runtime.ts`, `src/modules/harness/inflexa_classify.ts`, `src/cli/index.ts` | A `!` on a group, a segment, or an element after a length test. | A destructure and an `undefined` test, with the same result. `src/lib/credential.ts` returns `null` for an absent segment, the same as the length test. The help table of `src/cli/index.ts` measures each column over the cells that exist. |
| `scripts/build.ts` | `process.env.X!` passes `undefined` on to `audienceInvalidReason`. | `present` throws with the variable name. The missing-variable loop makes the path unreachable. |
| `src/modules/harness/inflexa_tool.ts` `store add` on a forced scope | A scope with another kind, forced at runtime, gives no `--analysis`. | The call appends `--analysis` with no value (`scoped.analysisId` is `undefined`). The type forbids this scope, and cli builds the scope with `kind: "analysis"` at `turn.ts:127`. |
| `src/modules/harness/inflexa_tool.ts` child `cwd` on a forced scope | `undefined`, from the guard. | `resolveAnalysisFolder(undefined)`, which gives `undefined` for the test host. The test `inflexa_tool.test.ts:729-736` passes unchanged. |
| `src/modules/harness/inputs_tool.ts`, `launch_dir_tool.ts` on a forced scope | `no_analysis` from the guard. | `findAnalysis(undefined)` finds no row and gives `no_analysis`. The test `launch_dir_tool.test.ts:72-84` passes unchanged. |
| `src/modules/harness/usage_recorder.ts` on an unknown scope variant | `record` gives the `err` "usage record dropped: unhandled scope variant". | The mapper reads `scope.analysisId`. The type has one variant, and a new variant fails to compile at the read. A forced runtime variant now reaches the upsert, and a bind failure there maps to the `err` of the notice through the existing `Result.fromThrowable`. |
