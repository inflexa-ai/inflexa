# Tasks

## 1. The tool and its configuration

- [x] 1.1 Add `jscpd` at the exact version `5.4.2` (the version of harness) to `cli/package.json` dev dependencies, and update `cli/bun.lock` with a cli-local `bun install`
- [x] 1.2 Write `cli/.jscpd.json`: formats `typescript` and `tsx`; ignores `**/node_modules/**`, `**/dist/**`, `**/dist-docs/**`; floor `minTokens: 60` and `minLines: 15`; a `"//"` key that gives the reason for the floor with the measured ladder (349 clones at 60/5, 129 at 60/10, 45 at 60/15, 39 at 70/15, 11 at 100/20, measured on `56dc6568`), the reason for each ignored tree, the reason that the data formats stay outside, and the reason that the package-store fixtures stay outside through the format list
- [x] 1.3 Add the `dupes` script to `cli/package.json`: `jscpd src scripts --exit-code --fail-on-empty`
- [x] 1.4 Run `bun run dupes` in `cli/` and record the reported clone set. On `56dc6568` the set is the 45 clones the design measured (11 in source files, 34 in test files). A clone that a newer merge to `main` added is a new copy to remove in this change, not a mismatch.

## 2. The source copies

Design Decision 5 governs this group and the next two: each copy collapses into a shared abstraction; an ignore region keeps a copy only for a reason the design accepts.

- [x] 2.1 Wrap the spec-table oracle of `src/test_support/file_types.ts` in `jscpd:ignore-start`/`ignore-end` markers with a comment that states the reason (an independent test copy is the oracle that fails when the map and the spec disagree), and verify the route tests of the file-type table still pass
- [x] 2.2 Collapse the shared materialize → seed → trigger → outcome block of the parity ladder and `forceReprofile` in `src/modules/harness/profile_trigger.ts` into one dispatch helper that takes the failed-row policy, and run the tests of `src/modules/harness/` that cover the profile trigger
- [x] 2.3 Collapse the shared per-artifact owned-path, lstat, kind, and size checks of `receiptFilesPresent` and `receiptFilesIntact` in `src/modules/refs/store.ts` into one per-artifact check helper, and run the tests of `src/modules/refs/`
- [x] 2.4 Collapse the shared switch tail (the four no-op frame kinds, the `checkChatPart` gate, the log-and-drop) of `src/modules/harness/dev/chat.ts` and `src/tui/hooks/conversation.ts` into one shared part-reader helper in `src/lib/` that takes the apply callback, and run the tests of both files
- [x] 2.5 Collapse the repeated guard prologue of the four session flows in `src/tui/commands.tsx` into one file-local helper that returns the read thread or notifies, and run the session-flow tests of `src/tui/test/`
- [x] 2.6 Collapse the shared chrome box of `src/tui/components/ask_prompt.tsx` and `src/tui/components/pause_prompt.tsx` into one shared frame component in `src/tui/components/`, and run the render tests of the two prompts
- [x] 2.7 Collapse the shared frame-and-age interval clock of `src/tui/components/boot_indicator.tsx` and `src/tui/components/thinking_indicator.tsx` into one shared clock helper, and run the tests that cover the two indicators
- [x] 2.8 Collapse the shared focus/blur subscription pair of `src/tui/components/text_area.tsx` and `src/tui/components/text_input.tsx` into one shared focus-tracking helper (the ref callback stays inline at each editor), and run the render tests of the two editors
- [x] 2.9 Collapse the shared temp-directory, descriptor, read-back, and cleanup scaffold of `runCli` and `runCliAsync` in `src/test_support/cli.ts` into one helper that takes the spawn call, and run one test that uses each runner
- [x] 2.10 Run `bun run dupes` after this group: no clone of this group remains in the report

## 3. The within-file test copies

- [x] 3.1 Parameterize or share the repeated blocks of `src/cli/test/agent_policy_tree.test.ts` (25 lines) into cases or one local helper, and run the file's tests
- [x] 3.2 Parameterize or share the repeated blocks of `src/modules/embedding/test/local-provider.test.ts` (3 reports) into cases or one local helper, and run the file's tests
- [x] 3.3 Parameterize or share the repeated blocks of `src/modules/harness/test/inputs_tool.test.ts` and `src/modules/infra/test/setup.test.ts`, and run the tests of each changed file
- [x] 3.4 Parameterize or share the repeated blocks of `src/tui/hooks/test/boot.test.ts`, `src/tui/hooks/test/prompt_recall.render.test.tsx`, `src/tui/components/test/list_primitives.render.test.tsx`, `src/tui/layout/test/sidebar.render.test.tsx`, and `src/tui/test/keymap_interrupt_retract.render.test.tsx`, and run the tests of each changed file
- [x] 3.5 Run `bun run dupes` after this group: no clone of this group remains in the report

## 4. The cross-file test copies

- [x] 4.1 Move the shared session-dialog scaffold (the session options double, the dialog-host mount, the frame capture) of `src/tui/test/session_delete_dialog.render.test.tsx`, `src/tui/test/session_remove_dialog.render.test.tsx`, and `src/tui/test/session_restore_dialog.render.test.tsx` into one shared helper in `src/test_support/`, and run the three files' tests
- [x] 4.2 Move the shared render-harness blocks of the keymap render tests (`src/tui/test/keymap_scroll.render.test.tsx`, `src/tui/test/keymap_selection.render.test.tsx`, their cross-file pairs in `src/tui/components/dialog/test/dialog_host.render.test.tsx` and `src/tui/hooks/test/prompt_recall.render.test.tsx`) into one shared helper in `src/test_support/`, and run the tests of each changed file
- [x] 4.3 Move the shared dialog render scaffold of `src/tui/components/dialog/test/` (the `file_picker`, `select_dialog`, and `usage_dialog` render tests) into one shared helper in `src/test_support/`, and run the tests of each changed file
- [x] 4.4 Move the shared run fixture builders of `src/tui/hooks/test/activity_panel.test.ts` and `src/tui/hooks/test/run_completion.test.ts`, and of `src/tui/test/app_activity_panel.render.test.tsx` with `src/tui/test/keymap_chord_uniqueness.render.test.tsx`, into shared helpers in `src/test_support/`, and run the tests of each changed file
- [x] 4.5 Collapse the repeated blocks of the remaining cross-file test pairs — `src/cli/test/read_commands.test.ts` with `src/cli/test/usage_command.test.ts`, `src/client/commands/test/store.test.ts` with `src/modules/refs/test/commands.test.ts`, `src/modules/embedding/test/llama_runtime.test.ts` with `src/modules/embedding/test/setup.test.ts`, `src/modules/harness/test/prov_bridge.test.ts` with `src/modules/harness/test/run_bridge.test.ts`, `src/modules/prov/test/lineage.test.ts` with `src/modules/prov/test/prov.test.ts`, `src/tui/test/commands.test.ts` with `src/tui/test/report_session_flows.test.ts`, `src/tui/test/remove_inputs_dialog.render.test.tsx` with `src/tui/test/switch_analysis_picker.render.test.tsx`, `src/tui/components/test/tool_block.render.test.tsx` with `src/tui/layout/test/run_card_settle.render.test.tsx`, `src/tui/layout/test/chat_bar.render.test.tsx` with `src/tui/layout/test/message_block.render.test.tsx`, and `src/tui/test/input_focused_contrast.render.test.tsx` with `src/tui/test/theme_contrast.render.test.tsx` — into a shared helper per cluster in `src/test_support/`, and run the tests of each changed file
- [x] 4.6 Run `bun run dupes` after this group: it reports no clone

## 5. The gate in CI and its verification

- [x] 5.1 Add a step that runs `bun run dupes` to the `lint (cli)` job of `.github/workflows/lint.yml`, after the Typecheck step, with the source-validity-gate comment of the harness step
- [x] 5.2 Run `bun run dupes` in `cli/` on the finished tree: it must report no clone and exit 0
- [x] 5.3 Do a test of both failure paths: a scratch file under `cli/src` that copies a block at or above the floor makes `bun run dupes` exit non-zero, and a run whose filters match no file exits non-zero (for example `bunx jscpd tmp --exit-code --fail-on-empty`, a directory that exists and holds no code-format file); then remove the scratch file
- [x] 5.4 The done-when of the issue holds: `bun run lint`, `bun run typecheck`, and `bun run test` pass in `cli/`
