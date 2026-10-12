# Tasks

## 1. Contracts

- [x] 1.1 Add `invocationId?: string` to the wire `EventSource` (`contracts/chat-events.ts`), the loop `EventSource` (`loop/types.ts`), and `EventSourceSchema`. Make `toSource` (`contracts/chat-frame.ts`) copy it only when present. Make sure with `src/contracts/chat-frame.test.ts` cases: a source with `invocationId` keeps it, a source without one gives no key.
- [x] 1.2 Add `at?: string` to `StepActivityPart` and its schema, and `reply?: "once" | "always" | "reject"` to `AskPart` and `AskPartSchema`. Make sure with `src/contracts/chat-frame.test.ts` (the `checkChatPart` tests) that `checkChatPart` keeps both fields and accepts a part with neither.
- [x] 1.3 Add `SubAgentActivityEntry`, `SubAgentActivityPart` (`data-subagent-activity`), and `ActivityEntryPart` (`data-activity-entry`) to `contracts/chat-parts.ts`, with schemas in `contracts/schemas/chat-parts.ts`, union members, and registry entries (`data-subagent-activity`: conversation, conversation, not transient, reconciling; `data-activity-entry`: workflow, sidebar, not transient, not reconciling). Make sure with `src/contracts/chat-parts.test.ts` and `bun run typecheck`.
- [x] 1.4 Add `contracts/subagent-activity.ts` with `createSubAgentActivityTracker()` and `SUBAGENT_ACTIVITY_MAX_ENTRIES = 200`, as the chat-frame-translation delta and design.md describe. The module imports only types from outside `contracts/`. Make sure that a new `src/contracts/subagent-activity.test.ts` covers each scenario of the tracker requirement. Also cover the label merge and a finish with no recorded entry.
- [x] 1.5 Export the tracker, the new part types, and the new schemas from `contracts/index.ts`, `contracts/schemas/index.ts`, and `src/index.ts`. Make sure with `tsc -p tsconfig.build.json`.

## 2. Loop

- [x] 2.1 Stamp `invocationId` on the source in `openLoop` (`loop/run-agent.ts:351-354`) with a conditional spread from `opts.invocationId`. Make sure with `src/loop/run-agent.test.ts` that a run with `invocationId` emits it on `tool-started`, `tool-finished`, and `iteration`. A run without it emits no key. The compaction exchange of a loop with no `invocationId` (the root turn) still emits no key. Update each sub-agent fixture that asserts a whole `source`.

## 3. Display recorder and storage

- [x] 3.1 Add the `subagent-activity` key to `ConversationUIData` and `dataSchemas` in `memory/conversation-display-storage.ts`, with a stored schema that requires `outcome` on each entry. Make `conversationDisplayPart` close each entry with no outcome as `incomplete`, with no `endedAt`. Make sure with `src/memory/conversation-display-storage.test.ts`: a part round-trips field for field, and an open entry is stored `incomplete`.
- [x] 3.2 Give the recorder one tracker for the turn and an injected `now?: () => number` (default `Date.now`). Give each frame to the tracker before the root filter, and apply each part that it gives through the existing conversation-part path. Make sure with `src/memory/conversation-display-recorder.test.ts` that sub-agent tool calls become entries of the part of their root call. A sub-agent display part and sub-agent text stay out. A frame with no invocation id leaves no record. An unfinished entry closes `incomplete`.
- [x] 3.3 Change the live path of `src/memory/conversation-display-parity.test.ts` to `toChatFrame`, then the tracker, then `applyChatFrame`, with one clock for the two paths. Give the sub-agent events of the primary fixture an `invocationId`, and expect the `data-subagent-activity` part in the two lists. Add the known-difference test for an unfinished sub-agent call. Make sure that the parity test passes.
- [x] 3.4 Add replay tests in `src/memory/conversation-display-replay.unit.test.ts`. A stored `data-subagent-activity` part reads back field for field. A settled `data-ask` keeps its `reply` after the reload. Make sure that the tests pass.

## 4. Activity history in the workflows

- [x] 4.1 In `workflows/sandbox-step.ts`, make `emitActivity` read `DBOS.now()` one time, write `data-step-activity` with `at`, and then write one `data-activity-entry` with the id `stepPartId("activity-entry", runId, stepId)` plus `-<seq>`. Advance `seq` before the writes. Each write fails alone through `safeEmit`. Make sure with `src/workflows/sandbox-step.test.ts` that each activity part has `at`, and one entry with the same phase, activity, and time comes after it. The ids are unique and in sequence, and the local fold keeps each entry. A rejected entry write is logged, and the step continues.
- [x] 4.2 Give `createProfileActivityEmitter` (`tasks/data-profile-activity.ts`) an injected `now: () => Promise<number>`, and write the activity part with `at` and then its entry, with the same id rule and independent failure. Pass `() => DBOS.now()` from `tasks/data-profile.ts`. Make sure with `src/tasks/data-profile-activity.test.ts` that each part has its exact shape with `at`, and one entry follows each emission. The ids are unique and in sequence. A failed entry write is logged and does not stop the next emission. Two emitters on the same clock sequence give equal parts and ids, which is the replay property.
- [x] 4.3 Make sure with `src/execution/run-event-parts.test.ts` that `foldRunEventParts` keeps each `data-activity-entry` and folds `data-step-activity` to the newest one, and that `pipeFoldedRunEvents` passes each entry at once.

## 5. Ask reply

- [x] 5.1 Make the terminal emission of `tools/approval/gateway.ts` carry `reply` from the ledger row: `once` or `always` for `resolved` with the narrowing of `settle`, and `reject` for `rejected`. The pending, aborted, expired, and vanished-row emissions carry none, and the part never carries the reject feedback. Make sure with `src/tools/approval/gateway.test.ts` (Postgres): an `always` answer gives `reply: "always"`, a `once` answer gives `reply: "once"`, and a reject with feedback gives `reply: "reject"` and no feedback.

## 6. Checks

- [x] 6.1 Run `bun run format:file` on each changed file in `src/`, then `bun run typecheck`, `bun run lint`, and `tsc -p tsconfig.build.json`. Make sure that each command passes.
- [x] 6.2 Run the changed unit tests with `bun test <paths>`, and the Postgres tests with `bun run test:full src/tools/approval/gateway.test.ts src/app/chat-turn.test.ts`. Make sure that each passes.
