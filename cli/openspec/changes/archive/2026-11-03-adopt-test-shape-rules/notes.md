# Notes

## Measurements

Design Context (rule on, before any fix):

- 410 reports in 71 files.
- 402 reports in 63 test files.
- 8 reports outside the tests: 5 in the source and 3 in `src/test_support/`.

Live run of `bun --bun oxlint -f unix src scripts` after task 1.1: 410 problems, all `typescript/require-await`, in 71 files. The output is `tmp/claude/809/live-after-1.1.txt` under `cli/`.

Live run after group 1: 402 problems. All 402 are in the test files. No report remains in the source or in `src/test_support/`.

Close-out (task 5.1): `bun run lint` exit 0 with no report, and `bun run typecheck` exit 0. The full `bun run test`: 4852 pass, 2 skip, 0 fail, 17720 `expect()` calls, 4854 tests across 236 files. The 63 baseline test files: 2183 pass, 0 fail, 7573 `expect()` calls, the same as before the change.

## Behavior differences

- Design D6: a `void` callback double that was `async` and threw gave a rejection that nothing awaited. After the change it throws at the call site. Group 1 found no such double.
- Design D6: `renderChat` and `sandboxPull` settle their callers one microtask earlier. No code reads that timing.
- Group 1 found no other difference. `register` still returns a refusal for a throw from a bus subscriber: the new test in `prov_bridge.test.ts` passed before and after the edit of `registerOnBus`.
- Group 3 found no behavior difference. Each double that rejected still rejects.
- Group 4 found no behavior difference. The `sseResponse` producer of `http.test.ts` that throws after it sends a frame still rejects, through `Promise.try`. The `runs.test.ts:98` site that the design lists is a `start: async () => undefined`, so it became `() => Promise.resolve()`.

## New shapes

Group 1 found no shape that design D1 to D5 does not name.

Group 2 (task 2.1):

- `runtime.test.ts`: the doubles of `recordingSeams` and the overrides of the boot tests (13 sites) followed one multi-line shape, `async () => { calls.push(name); return value; }`. A local builder `recorded(calls, name, answer)` replaces it. It returns `() => Promise.try(() => { calls.push(name); return answer(); })`. A throw from `answer` rejects, as the `async` form did. The `boot` double that throws (`:766` before the edit) uses `recorded(calls, "boot", () => { throw ... })`.
- `Promise.try` for a block body that calls an injected or a throwing function: `composeUp` (`readFileSync`), `pullImageThroughEngine` (`onProgress`), `container.capture` of `postgres.test.ts` (`script.ready`), the `select` spy that calls `present(...)`, `check` of `warnStalePins` (`verdict`), the `fetch` double of `probeOnce` (`requestedModel`), and `launch` of `run.test.ts` (`launchThrows`).
- `model_listing.test.ts`: the `readProxyKey` default of `seamsFor` and of the second double builder cannot throw, thus each became `() => Promise.resolve(ok("sk-proxy"))`. `recordingFetch` already took a Promise factory with `Promise.resolve` at its call sites, thus it did not change. The fetch double that threw (`:38,317` in the design list) is the `readProxyKey` default, which has no throwing body.

Group 3 (task 3.1):

- Constant fetch doubles (`new Response(...)` with fixed arguments) became `respondWith(...)` at 14 sites in `geo.test.ts`, `refs/test/commands.test.ts`, `refs/test/store.test.ts`, `update/test/apply.test.ts`, `update/test/latest.test.ts`, `download.test.ts` (two sites over a stream), and `proxy/test/models.test.ts`. The local builders `declaring` (`refs/test/commands.test.ts`) and `redirectTo` (`update/test/latest.test.ts`) now return `respondWith(...)`, thus they make the Promise themselves. No new local builder.
- Throwing doubles: `geo.test.ts` (the `ECONNRESET` fetch stubs) became `Promise.reject(new Error(...))` after the `calls += 1` statement for the first stub, and `Promise.reject` alone for the second. `sealGlobalFetch` of `refs/test/commands.test.ts` records into `escaped`, then returns `Promise.reject(new Error(...))`. The double of `server.test.ts` (`ECONNREFUSED`, `socket closed`) and `store.test.ts` of the client take `Promise.try`, because they parse a body, call `new URL`, or throw at different depths. The sync double of `latest.test.ts` (`fetchLatestVersion(() => { throw ... })`) stays sync. The `latest.test.ts` site that the scout listed at `:46` is a constant `new Response`, thus it became `respondWith`.
- `Promise.try` for a block body that calls `expect`, a parse, `_unsafeUnwrap`, `String(input)` with a `new Headers`, `sha`, or an injected function: `countingRunner`, `acquiringRunner`, and `loadCheck` of the libs tests, the two `transfer` doubles of `store.test.ts` that unwrap Results, the `serve*` doubles of `refs/test/store.test.ts` and `update/test/apply.test.ts`, the `serveDirs` and the fixture builders of `geo.test.ts`, the `fetch` doubles of `models.test.ts`, `download.test.ts` `serve` (a computed status), and `capture(() => Promise.try(...))` in `refs/test/commands.test.ts`.
- `Promise.resolve(value)` for a block body that cannot throw: the `ProvisionerRunner` doubles that count `ran` and return `ok(...)`, the `confirmDownload` and `inspect` doubles, the `fetch` recorders, the `chunks.push(bytes)` writers of `walk_child.test.ts` and `search_index.test.ts`, and the `requireServer` doubles of `agent_policy.test.ts`.
- Sync (no Promise): the `registerAction` handler of `agent_policy.test.ts`. Its type is `void | Promise<void>` and its caller awaits it inside an `async` action.

Group 4 (task 4.1):

- Constant doubles of a member that returns a Promise became `() => Promise.resolve(value)`, and the `void x.push(...)` doubles became a block that records, then returns `Promise.resolve()`. These are the `ServerBoot.start`, `busyReasons`, `pendingAsks`, `resolveThreadId`, `reloadTranscript`, `refresh`, `watchTurn`, `pollThread`, `pollPaused`, `checkServer`, `refreshSidebar`, `__setClipboardWriterForTest`, and `serializeProfileWork` doubles. The Result spies and doubles (`ok(undefined)`, `err(reason)`) keep `mockImplementation` and `Promise.resolve(result)`.
- `Promise.try` for a block body that calls an injected function or the code under test: the two `sseResponse` producers of `http.test.ts` (the second one throws after it sends a frame, so it still rejects), the two `runTurn` doubles of `routes/test/conversation.test.ts` (`args.onOpened`, `args.emit`), the `retract` double of `keymap_interrupt_retract.render.test.tsx` (`seed`), `busyReasons` of `anchors.test.ts` (`Promise.try(busy, analysisId)`, because `busy` is a caller-given function), and the `fetch` doubles that parse a body, call `new URL`, or choose between two responses (`usage_dialog.test.ts`, `sidebar.render.test.tsx` `usageServer`, `commands.test.ts` `answering` and the `view.status` spy).
- `Promise.resolve(value)` after a recording statement for a block body that cannot throw: the `ensureProxyReady` and `bootHarnessRuntime` spies of `server/test/boot.test.ts`, the `list`, `resume`, and `hold` doubles of `paused_work.test.ts`, the `collectDebris`, `subscribeRun`, `start`, `sleep`, `startDownload`, `refreshSidebar`, `quit`, `openAnalysis`, and `save` doubles, and the `fetch` spy of the `view.status` failure test in `commands.test.ts` (a constant `Response`).
- `respondWith` for the one constant fetch double of `sidebar.render.test.tsx` (`failing`). No other site of the scope is a constant fetch double.
- `streamOf` at 6 sites: `read: () => streamOf(frames)` in `routes/test/conversation.test.ts`; `framesOf` in `plan_steps_command.test.tsx` (`streamOf(frames.map((frame) => ok(frame)))`); and the four streams of `tui/hooks/test/conversation.test.ts` (two `frames`, `first`, `again`), where the call sits in a `startTurn` or `rereadTurn` arrow, or in a local arrow that returns it. `streamOf` takes the type argument `Result<ChatFrame, ClientError>` there, because the literal frames do not infer it.
- An `async` test callback with no await dropped `async` at `server/test/boot.test.ts` and `tui/contexts/test/workspace.test.ts`. No `return Promise.resolve()` was added.
- `analysisIn` of `sidebar.render.test.tsx` is a test helper, not a double. It dropped `async` and returns `Promise.resolve(analysisRow(name))`, so its nine `await` sites stay.
- The `unexpected(...)` doubles of `plan_steps_command.test.tsx` and `failing(...)` of `runs.test.ts` are sync, throw-only doubles that were never `async`. They did not change.

## Test strength

Count of `expect(` in the source text of each changed or new test file, before and after:

| File | Before | After |
| --- | --- | --- |
| `src/modules/harness/test/prov_bridge.test.ts` | 149 | 152 |
| `src/test_support/test/stream.test.ts` | new | 2 |
| `src/test_support/test/fake_fetch.test.ts` | new | 9 |
| `src/modules/harness/dev/test/run.test.ts` | 35 | 35 |
| `src/modules/harness/test/eyes.test.ts` | 23 | 23 |
| `src/modules/harness/test/inflexa_tool.test.ts` | 137 | 137 |
| `src/modules/harness/test/model_listing.test.ts` | 111 | 111 |
| `src/modules/harness/test/profile_trigger.test.ts` | 84 | 84 |
| `src/modules/harness/test/run_deps.test.ts` | 28 | 28 |
| `src/modules/harness/test/runtime.test.ts` | 170 | 170 |
| `src/modules/harness/test/usage_ledger.test.ts` | 23 | 23 |
| `src/modules/infra/test/compose.test.ts` | 116 | 116 |
| `src/modules/infra/test/postgres.test.ts` | 74 | 74 |
| `src/modules/infra/test/setup.test.ts` | 402 | 402 |
| `src/cli/test/agent_policy.test.ts` | 18 | 18 |
| `src/cli/test/setup_flags.test.ts` | 8 | 8 |
| `src/client/commands/test/server.test.ts` | 41 | 41 |
| `src/client/commands/test/store.test.ts` | 3 | 3 |
| `src/lib/test/download.test.ts` | 27 | 27 |
| `src/modules/anchor/test/backstop.test.ts` | 23 | 23 |
| `src/modules/embedding/test/setup.test.ts` | 143 | 143 |
| `src/modules/fs/test/search_index.test.ts` | 113 | 113 |
| `src/modules/fs/test/walk_child.test.ts` | 38 | 38 |
| `src/modules/geo/test/geo.test.ts` | 88 | 88 |
| `src/modules/libs/test/store.test.ts` | 84 | 84 |
| `src/modules/libs/test/store_flight.test.ts` | 102 | 102 |
| `src/modules/prov/test/export.test.ts` | 12 | 12 |
| `src/modules/proxy/test/models.test.ts` | 95 | 95 |
| `src/modules/refs/test/commands.test.ts` | 167 | 167 |
| `src/modules/refs/test/store.test.ts` | 129 | 129 |
| `src/modules/update/test/apply.test.ts` | 18 | 18 |
| `src/modules/update/test/latest.test.ts` | 22 | 22 |
| `src/server/routes/test/analyses.test.ts` | 144 | 144 |
| `src/server/routes/test/anchors.test.ts` | 36 | 36 |
| `src/server/routes/test/artifacts.test.ts` | 67 | 67 |
| `src/server/routes/test/attention.test.ts` | 48 | 48 |
| `src/server/routes/test/conversation.test.ts` | 188 | 188 |
| `src/server/routes/test/fs.test.ts` | 365 | 365 |
| `src/server/routes/test/machine.test.ts` | 198 | 198 |
| `src/server/routes/test/paused_work.test.ts` | 26 | 26 |
| `src/server/routes/test/runs.test.ts` | 230 | 230 |
| `src/server/routes/test/store.test.ts` | 25 | 25 |
| `src/server/test/app.test.ts` | 80 | 80 |
| `src/server/test/boot.test.ts` | 37 | 37 |
| `src/server/test/http.test.ts` | 51 | 51 |
| `src/server/test/profile_queue.test.ts` | 20 | 20 |
| `src/tui/components/dialog/test/usage_dialog.test.ts` | 25 | 25 |
| `src/tui/contexts/test/workspace.test.ts` | 24 | 24 |
| `src/tui/hooks/test/boot.test.ts` | 71 | 71 |
| `src/tui/hooks/test/conversation.interrupt_retract.test.ts` | 121 | 121 |
| `src/tui/hooks/test/conversation.render.test.tsx` | 3 | 3 |
| `src/tui/hooks/test/conversation.test.ts` | 341 | 341 |
| `src/tui/hooks/test/farm_heal.test.ts` | 13 | 13 |
| `src/tui/hooks/test/pauses.test.ts` | 25 | 25 |
| `src/tui/hooks/test/profile_parity.test.ts` | 43 | 43 |
| `src/tui/hooks/test/sidebar_live.test.ts` | 211 | 211 |
| `src/tui/layout/test/sidebar.render.test.tsx` | 228 | 228 |
| `src/tui/test/commands.test.ts` | 277 | 277 |
| `src/tui/test/keymap_interrupt_retract.render.test.tsx` | 42 | 42 |
| `src/tui/test/model_picker.render.test.tsx` | 52 | 52 |
| `src/tui/test/plan_steps_command.test.tsx` | 9 | 9 |
| `src/tui/test/report_session_flows.test.ts` | 197 | 197 |
| `src/tui/test/session_delete_dialog.render.test.tsx` | 6 | 6 |
| `src/tui/test/session_remove_dialog.render.test.tsx` | 5 | 5 |
| `src/tui/test/session_restore_dialog.render.test.tsx` | 9 | 9 |
| `src/tui/test/switch_analysis_picker.render.test.tsx` | 22 | 22 |
