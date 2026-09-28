## 1. Harness

- [x] 1.1 Add the plan step fields to `PlanStep` and `PlanStepSchema`, with a failing recorder test first.
- [x] 1.2 Add `checkChatPart`, with tests, and use it in the display recorder.
- [x] 1.3 Add `reconcileKey` and `upsertPart`, and use them in `applyChatFrame`, the replay, and the run-event fold.
- [x] 1.4 Export the message types and each chat part type from the root barrel.

## 2. CLI

- [x] 2.1 Check each live part at receipt with `checkChatPart`, in the TUI and in the dev REPL.
- [x] 2.2 Type the part readers on the harness part types.
