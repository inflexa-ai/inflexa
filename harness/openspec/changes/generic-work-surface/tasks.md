# Tasks

## 1. The user message in the stream of a turn

- [x] 1.1 Make `MessageStartEvent` a union by `role`, with the necessary `text` on the `user` variant, in the contract type, the schema, and the emit event of the loop (D4). Do a test: the schema refuses a user `message-start` with no text.
- [x] 1.2 Write the sanitized user text in the user `message-start` of `toChatFrame`, of the display recorder, and of the turn workflow. Do the tests of `toChatFrame` and of the recorder.
- [x] 1.3 Make `applyChatFrame` add the user message from a user `message-start`, when no message has that id (D4). Do tests: the frame adds the user message, and the frame keeps a message with the same id.

## 2. The work surface

- [x] 2.1 Add `queryTurnsOfAnalysis` in `state/active-turns.ts` (D1).
- [x] 2.2 Add `stopDataProfile` and `DATA_PROFILE_STOPPED` in `tasks/data-profile.ts` (D3). Do a DBOS test: a stop of a paused profile cancels the workflow, fails the row, and deletes the pause rows.
- [x] 2.3 Replace `app/paused-work.ts` with `app/work.ts`. Make `list` give each active work, and add `stop` for each kind (D1, D2). Do DBOS tests: a running run with no waits is in the list, a stop of a paused run and of a paused turn ends the work, and work of a different analysis gives `not_found`.
- [x] 2.4 Change the type names to `WorkKind`, `Work`, `WorkSurface`, `WorkResume`, and `WorkHold`, and add `WorkStop`. Export them and `DATA_PROFILE_STOPPED` from the package.
- [x] 2.5 Give `CoreRuntime.work` in place of `CoreRuntime.pausedWork`, with a run canceler that the runtime makes (D2). Do the test of the assembly.

## 3. The consumers and the verification

- [x] 3.1 Adapt the CLI to `CoreRuntime.work`.
- [x] 3.2 Update `CLAUDE.md`, `CONTEXT.md`, and `README.md` of the harness: `CoreRuntime.work` replaces `CoreRuntime.pausedWork`.
- [x] 3.3 Run the harness and CLI checks.
