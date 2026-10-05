# Home the dev-only command surfaces, and give each shared helper its own module

## Why

The CLI gates its dev/E2E commands at registration — `src/cli/index.ts:296`, behind `devCommandsEnabled()` — and the `dev-commands` spec records that gate. The tree says nothing. A reader who opens `src/modules/harness/` finds `chat.ts`, `run.ts`, and `profile.ts` beside the product modules. Nothing there shows that a release build carries none of the three. Issue #56 asks the tree to state the channel too, beside the one registration gate.

The move cannot happen as the files stand, because two of them mix a shared half with a dev half:

- `profile.ts` (498 lines) holds three helpers that the product imports: `describeBootError` (`src/tui/app.launch.tsx:14`, `src/tui/hooks/boot.ts:5`), `ensureSandboxImage` (`src/tui/app.launch.tsx:48`), and `seedProfileLedger` (`src/modules/harness/profile_trigger.ts:17`). Beside them sit the `inflexa profile` command actions and the status readers that only `inflexa run` calls.
- `chat_printer.ts` (441 lines) holds six readers the TUI consumes at `src/tui/hooks/conversation.ts:21` beside the stdout printer that only `inflexa chat` builds. The `chat-command` spec's Purpose claims the whole file for the dev command, which is half wrong today.

The status readers are a second reason to act now. `friendlyStepLabel`, `readNewestWorkflowStep`, `runWorkflowFamily`, `formatElapsed`, and `withStatusPool` have no product consumer left. The one caller of those readers is now `src/modules/harness/run.ts:59`, which is itself dev-only. Nothing in the tree shows that.

The TUI activity panel refuses those readers on purpose. `src/tui/hooks/activity_panel.ts:250-258` gives the reason: the durability engine records a step only when that step returns. Thus a completed-step row cannot describe work in flight.

## What Changes

Behavior does not change. This is a location and ownership change, and it lands in two ordered phases so the second phase is a pure file move.

**Phase 1 — send each shared helper to the module that owns its subject.**

- `describeBootError` moves to `src/modules/harness/runtime.ts`. That file declares the `HarnessBootError` union at `runtime.ts:181` and `bootHarnessRuntime` at `runtime.ts:406`. The function is a total switch over that union, with the `never` guard at `profile.ts:115-118`. A new variant must then cost one file to edit, not two.
- `ensureSandboxImage` moves to `src/modules/libs/pull.ts`. That module owns the sandbox image, and its spec already owns the function: `openspec/specs/lib-store-provisioning/spec.md:116` holds a requirement titled "`ensureSandboxImage` pulls the image from GHCR when missing". `pull.ts:20-23` already imports the exact set that the function uses. The inline presence lookup at `profile.ts:133` duplicates the private `imagePresent` at `pull.ts:86-88` and collapses into it.
- `seedProfileLedger` moves to `src/modules/harness/profile_trigger.ts`, its only product consumer (`profile_trigger.ts:17,125`), which already documents the shared ledger contract at `:26` and `:88`.
- `eventDepth` (`chat_printer.ts:104`) moves to `src/tui/hooks/conversation.ts`, its one caller (`:360`). The printer never calls it, so it is not shared code.
- The `Spinner` alias exists twice, at `profile.ts:36` and `run.ts:62`. One alias moves to `src/lib/cli.ts`, which is already the sanctioned `@clack/prompts` boundary (`cli.ts:1`), and both files use that one.
- `profile.test.ts` splits so each block stays beside its subject.

**Phase 2 — home the dev-only surfaces under `src/modules/harness/dev/`.**

- `chat.ts` and `run.ts` move unchanged. Their one importer is the dev-gated registry at `src/cli/index.ts:325,347`.
- `runProfile` (`profile.ts:180`) and `runProfileStatus` (`profile.ts:474`) move as the `inflexa profile` command actions.
- The status readers move with them, into their own file inside `dev/`, because both `dev/profile.ts` and `dev/run.ts` call them: `friendlyStepLabel`, `readNewestWorkflowStep`, `runWorkflowFamily`, `readRunProgress`, `formatElapsed`, `waitForTerminalStatus`, and `withStatusPool`.
- The printer folds into `dev/chat.ts` rather than into a file of its own. `createChatPrinter` has one caller, and `cli/CLAUDE.md:69-71` forbids a separate file for a single-caller helper. `chat_printer.ts` keeps the six readers, which two files consume.
- `src/modules/harness/profile.ts` then ceases to exist. No file is left with a name that describes none of its residents.

A file under `dev/` can import product code, because the dependency runs from the embedder's dev surface toward the product. A product file must not import `dev/`. Thus `seedProfileLedger` cannot go into `dev/`, because `profile_trigger.ts` is product code.

## Capabilities

### New Capabilities

<!-- None. This change adds one requirement to an existing capability and moves code. -->

### Modified Capabilities

- `dev-commands`: the dev-only command surfaces are homed under one directory, so the tree states the channel beside the registration gate.

## Impact

CLI source, phase 1:

- `src/modules/harness/runtime.ts` — receives `describeBootError`.
- `src/modules/libs/pull.ts` — receives `ensureSandboxImage`, which reuses `imagePresent`. The header at `pull.ts:3-5` claims "There is no second image-fetch path" while `pull.ts:11-12` names that second path and points at `modules/harness/profile.ts`. The move makes the first claim true and the second pointer dead, so the header correction is necessary either way.
- `src/modules/harness/profile_trigger.ts` — receives `seedProfileLedger`.
- `src/lib/cli.ts` — receives the one `Spinner` alias.
- `src/tui/hooks/conversation.ts` — receives `eventDepth`.
- Importers updated, never a shim (`cli/CLAUDE.md:396`): `src/tui/app.launch.tsx:14`, `src/tui/hooks/boot.ts:5`, `src/tui/hooks/boot.test.ts:8`, `src/tui/hooks/conversation.ts:21`, `src/modules/harness/profile_trigger.ts:17`, `src/modules/harness/profile_trigger.test.ts:7`, `src/modules/harness/profile.test.ts:3`, `src/modules/harness/chat.ts:26-27`, `src/modules/harness/run.ts:59`, `src/cli/index.ts:307`.

CLI source, phase 2:

- New directory `src/modules/harness/dev/`, which receives the chat REPL with its printer, the run launcher, the profile command actions, and the shared status readers.
- `src/modules/harness/chat_printer.ts` — keeps the six readers alone.
- `src/modules/harness/artifact_open.ts:15,21` — two comments name `chat_printer.ts` as the REPL printer. That printer then lives in `dev/chat.ts`.
- `src/cli/index.ts:307,325,347` — the three lazy imports point at the new files.
- `src/modules/harness/profile.ts` — deleted.

Specs:

- `openspec/specs/dev-commands/spec.md` — one added requirement, the delta of this change.
- `openspec/specs/chat-command/spec.md:4` — the Purpose pins `src/modules/harness/chat.ts` and claims `chat_printer.ts` whole. The change must correct both parts. No requirement in that spec names a path.
- `openspec/specs/analysis-run-launch/spec.md:4` — the Purpose pins `src/modules/harness/run.ts`. No requirement in that spec names a path.

Out of scope: the repeated pre-flight sequence. The config gate, then `ensureSandboxImage`, then the analysis lock appear three times — `src/tui/app.launch.tsx:46-54`, `src/modules/harness/chat.ts:94-105`, and `src/modules/harness/run.ts:344-390`. That is a shared helper, and it is a separate question from where a file lives.
