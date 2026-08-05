## 1. Phase 1 — dissolve the shared and dev mixes

- [x] 1.1 Move `describeBootError` from `src/modules/harness/profile.ts:38-120` into `src/modules/harness/runtime.ts`, beside the `HarnessBootError` union at `:181`. Keep the `never` guard. `runtime.ts:43` already imports the `env` that `:69` and `:77` use.
- [x] 1.2 Move `ensureSandboxImage` from `profile.ts:122-158` into `src/modules/libs/pull.ts`. Replace the inline presence lookup at `profile.ts:133` with a call to the private `imagePresent` at `pull.ts:86-88`. Make sure that `pull.ts` still imports nothing from `modules/harness`, per `pull.ts:56-58`.
- [x] 1.3 Add a comment in `pull.ts` that records why an exit-on-error function (`fail`, `src/lib/cli.ts:12-15`) sits beside the `Result`-returning `sandboxPull`. See the trade-off in `design.md`.
- [x] 1.4 Correct the `pull.ts:3-14` header: `:3-5` claims "There is no second image-fetch path" while `:11-12` names the second path and points at `modules/harness/profile.ts`.
- [x] 1.5 Move `seedProfileLedger` from `profile.ts:160-177` into `src/modules/harness/profile_trigger.ts`. Reconcile it with the contract notes already at `profile_trigger.ts:26` and `:88`.
- [x] 1.6 Move `eventDepth` from `chat_printer.ts:104` into `src/tui/hooks/conversation.ts`, its one caller at `:360`. Inline the `source` read that the private `eventSource` (`chat_printer.ts:74`) does. Do not export `eventSource`.
- [x] 1.7 Move one `Spinner` alias into `src/lib/cli.ts`, which is already the `@clack/prompts` boundary at `cli.ts:1`. Delete the two copies at `profile.ts:36` and `run.ts:62`, and import the one alias in both files.
- [x] 1.8 Update each importer of the moved symbols, and add no shim (`cli/CLAUDE.md:396`): `src/tui/app.launch.tsx:14`, `src/tui/hooks/boot.ts:5`, `src/tui/hooks/boot.test.ts:8`, `src/tui/hooks/conversation.ts:21`, `src/modules/harness/profile_trigger.ts:17`, `src/modules/harness/profile_trigger.test.ts:7`, `src/modules/harness/profile.test.ts:3`, `src/modules/harness/chat.ts:26-27`, `src/modules/harness/run.ts:59`, `src/cli/index.ts:307`.
- [x] 1.9 Split `profile.test.ts` so each block sits beside its subject: the `describeBootError` block (`:33-46`) goes to a `runtime` test file, and the `friendlyStepLabel` block (`:7-31`) stays with the status readers.
- [x] 1.10 Run `bun run format:file` on each source file that phase 1 changed (`cli/CLAUDE.md:3-6`).
- [x] 1.11 Run `bun run typecheck`, `bun run lint`, and `bun test`. Make sure that phase 1 is green before phase 2 starts.

## 2. Phase 2 — home the dev-only surfaces under `dev/`

- [x] 2.1 Make the directory `src/modules/harness/dev/`.
- [x] 2.2 Move `chat.ts` into `dev/chat.ts`, with no edit to its body beyond the import paths.
- [x] 2.3 Fold the printer into `dev/chat.ts`: `ChatSink` and `ChatPrinter` (`chat_printer.ts:41-89`), `PrinterOptions` and `createChatPrinter` (`:247-441`), and the printer-only helpers `formatMs` (`:133`), `hyperlink` (`:231`), and `formatTable` (`:236`). `chat_printer.ts` keeps the five shared readers, and `dev/chat.ts` imports them from there.
- [x] 2.4 Move `run.ts` into `dev/run.ts`, with no edit to its body beyond the import paths.
- [x] 2.5 Move the `inflexa profile` command actions `runProfile` (`profile.ts:180`) and `runProfileStatus` (`profile.ts:474`) into `dev/profile.ts`.
- [x] 2.6 Make `dev/status.ts` from the status readers that now have only dev callers: `friendlyStepLabel` (`:321`), `readNewestWorkflowStep` (`:345`), `runWorkflowFamily` (`:376`), `readRunProgress` (`:390`), `formatElapsed` (`:400`), `waitForTerminalStatus` (`:408`), and `withStatusPool` (`:448`). Drop the `export` from `friendlyStepLabel` if `readNewestWorkflowStep` stays its only caller.
- [x] 2.7 Delete `src/modules/harness/profile.ts`. Nothing must remain in it.
- [x] 2.8 Update the three lazy imports at `src/cli/index.ts:307`, `:325`, and `:347` to the new paths.
- [x] 2.9 Move each test file with its subject. Split `chat_printer.test.ts:4`, which imports both halves in one statement, so the printer blocks sit with `dev/chat.ts`.
- [x] 2.10 Run `bun run format:file` on each source file that phase 2 changed.
- [x] 2.11 Run `bun run typecheck`, `bun run lint`, and `bun test`.

## 3. Specs and documents

- [x] 3.1 Correct the Purpose of `openspec/specs/chat-command/spec.md:4`: it pins `src/modules/harness/chat.ts` and claims `chat_printer.ts` whole. The five readers are shared with the TUI, not the command's.
- [x] 3.2 Correct the Purpose of `openspec/specs/analysis-run-launch/spec.md:4`, which pins `src/modules/harness/run.ts`.
- [x] 3.3 Read `openspec/specs/harness-runtime/spec.md:164` and `openspec/specs/lib-store-provisioning/spec.md:116`. Both name `ensureSandboxImage`. Correct any text that places the function in the wrong module.
- [x] 3.4 Correct the two comments at `src/modules/harness/artifact_open.ts:15` and `:21`, which name `chat_printer.ts` as the REPL printer. That printer moves into `dev/chat.ts`.
- [x] 3.5 Read `cli/CLAUDE.md` "Project structure" (`:398-425`) and "Modules" (`:584-600`). Make sure that no line there contradicts the new `dev/` directory. Record the `dev/` convention if the section wants it.

## 4. Confirm the outcome

- [x] 4.1 Grep the tree for an import that resolves into `src/modules/harness/dev/` from outside it. There must be none.
- [x] 4.2 Grep for a re-export shim at any old path. There must be none.
- [x] 4.3 Run `bun run docs:gen`. It bakes a production channel and excludes each dev command by design (`cli/CLAUDE.md:909-914`). The emitted surface must be identical to the surface before this change.
- [x] 4.4 Run `bun run dev` and start `chat`, `profile`, and `run --status` against a scratch analysis. Each command must behave as it did before. `bun run typecheck` covers the three lazy-import paths, but `agent_policy_tree.test.ts` walks the registry without running a handler, so it does not reach them.
- [x] 4.5 Run `openspec validate home-dev-command-surfaces` from the `cli` directory.
