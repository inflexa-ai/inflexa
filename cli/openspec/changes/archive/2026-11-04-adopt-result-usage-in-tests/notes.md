# Notes

## Measurements

- Design Context count (scout run): 49 reports in 18 test files.
- Live `bun run typecheck` after task 1.1 (the `off` entry removed, `awaitOk` in `consumers`): 49 `must-use-result` reports, and no other report. The count agrees with the scout list.
- After the work of task groups 1 to 4: `bun run typecheck` gives no report.
- Close-out (task 5.1): `bun run lint` exit 0 with no report, and `bun run typecheck` exit 0 with no report. The full `bun run test`: 4857 pass, 2 skip, 0 fail, 17735 `expect()` calls, 4859 tests across 237 files. The 18 baseline test files: 872 pass, 1 skip, 0 fail, 3096 `expect()` calls (baseline 3091).
- The 49 reports: 45 awaited statements, and 4 yields. The 4 yields are done in group 2. The 45 awaited statements are done in groups 3 and 4.

## Site outcomes

| Site | Outcome |
| --- | --- |
| `src/modules/infra/test/compose.test.ts` "writes a failure line when the pull fails" | Err by design, confirmed by a run. The call gives `{ type: "image_pull_failed", image: DEFAULT_IMAGE }`. The site is `expect((await ...)._unsafeUnwrapErr()).toMatchObject({ type: "image_pull_failed", image: DEFAULT_IMAGE })`. |
| `src/modules/infra/test/setup.test.ts` "the pull progress callback reaches the pull of the images" | Err by design, confirmed by a run. The stub `composeUp` gives an err, thus `ensureProxyReady` gives a `ProxyError` whose message holds "Failed to start containers". The site asserts the `ProxyError` class and the message with `_unsafeUnwrapErr()`. |
| `src/modules/embedding/test/local-provider.test.ts` "a shutdown mid-launch reaps the in-flight child through the spawn slot" | Err by design, confirmed by a run. `launchP` gives `{ type: "provider" }` with a message that holds "exited (code 0) before becoming ready". The site asserts the `type` and the message. |
| `src/modules/refs/test/commands.test.ts` "progress readout teardown" | Throw, confirmed by a run. The site is `await awaitOk(downloadReferences(...))` inside the same `try`. The throw of the stub passes through the helper, and the exact assertion on `thrown.message` is unchanged. |

No other site intends an err. The 41 other awaited sites became `await awaitOk(<call>)`, and each test file passes, thus each of these calls gives an ok.

The four yields: `frameChannel` moved into `src/test_support/stream.ts` with one directive. The two yields of `conversation.render.test.tsx` each carry the same directive.

## Behavior differences

None for the product. No product code changed. In the test support, the two copies of `frameChannel` became one copy, and the doc comment of the shared copy says that each frame is a copy (`structuredClone`) and that `send` resolves after the consumer applied the frame. The earlier doc comments said "serialized and parsed again", which the code never did.

## Test strength

The count of `expect(` in the source text of each changed test file, before and after. No count is lower.

| File | Before | After |
| --- | --- | --- |
| `src/client/test/api.test.ts` | 44 | 44 |
| `src/lib/test/download.test.ts` | 27 | 27 |
| `src/modules/embedding/test/api_models.test.ts` | 18 | 18 |
| `src/modules/embedding/test/local-provider.test.ts` | 94 | 96 |
| `src/modules/geo/test/geo.test.ts` | 88 | 88 |
| `src/modules/harness/test/inflexa_tool.test.ts` | 137 | 137 |
| `src/modules/harness/test/inputs_tool.test.ts` | 39 | 39 |
| `src/modules/harness/test/launch_dir_tool.test.ts` | 13 | 13 |
| `src/modules/harness/test/model_listing.test.ts` | 111 | 111 |
| `src/modules/harness/test/runtime.test.ts` | 170 | 170 |
| `src/modules/infra/test/compose.test.ts` | 116 | 117 |
| `src/modules/infra/test/setup.test.ts` | 402 | 404 |
| `src/modules/libs/test/composition.test.ts` | 181 | 181 |
| `src/modules/refs/test/commands.test.ts` | 167 | 167 |
| `src/modules/update/test/apply.test.ts` | 18 | 18 |
| `src/tui/hooks/test/conversation.interrupt_retract.test.ts` | 121 | 121 |
| `src/tui/hooks/test/conversation.render.test.tsx` | 3 | 3 |
| `src/tui/hooks/test/conversation.test.ts` | 341 | 341 |
| `src/test_support/test/result.test.ts` (new) | 0 | 8 |

Run of the 18 baseline files, one file at a time: 872 pass, 1 skip, 0 fail, 3096 `expect()` calls in the summaries (baseline 3091). The first run of `conversation.test.ts` and `conversation.interrupt_retract.test.ts` before the move of `frameChannel`: 166 pass, 607 `expect()` calls. After the move, with `conversation.render.test.tsx`: 167 pass, 610 `expect()` calls.
