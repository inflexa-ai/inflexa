# Design

## Context

`workPause` (`src/workflows/pause.ts`) is the one pause primitive. Each waiting workflow calls it with a `PauseScope`. The primitive writes the row, emits the `data-pause` part, and waits with `DBOS.recv`. Then it clears the row and emits the end part. These workflows call it:

- the chat turn (`src/app/chat-turn-workflow.ts`)
- each sub-agent child, through `subAgentPauses` (`src/runtime/assemble.ts`, `src/loop/sub-agent.ts`)
- each sandbox step (`src/workflows/sandbox-step.ts`)
- the run workflow, for its charge gate and for its synthesis, with one shared pause (`src/workflows/execute-analysis.ts`)
- the data profile (`src/tasks/data-profile.ts`)
- the lease workflow (`src/sandbox/leases.ts`), whose emit does nothing

A lease workflow cannot write to the stream of its consumer. The `acquire` wait of the consumer reads the row of the lease workflow and mirrors it as a part (`mirrorPause` in `src/sandbox/leases.ts`).

A body operation that changes before a wait goes behind `DBOS.patch`, because a paused workflow replays its old operations after an upgrade. A change inside a step needs nothing.

The display recorder (`src/memory/conversation-display-recorder.ts`) keeps a part only when the registry gives `conversation` as its emitter and its consumer and the part is not transient. The registry gives `data-pause` the emitter `workflow`, and the stored vocabulary (`src/memory/conversation-display-storage.ts`) does not hold `data-pause`. An aborted turn stores an interruption note with no display (`interruptionNote` in `src/app/chat-turn.ts`), thus the open round of an aborted turn is not stored.

## Goals / Non-Goals

**Goals:**

- One waiter value that the row, the part, and the list carry, filled at each call site of `workPause`.
- The start, the end, and the cause of each wait in the part, live and after a reload.
- One `list` call that gives the active work of each analysis, with a fixed count of reads.

**Non-Goals:**

- A cli route or a cli type. The cli change adds `GET /api/v1/paused-work` and consumes the new fields.
- A new key of the part. The part stays keyed by the workflow id.
- A backfill of old rows. The user decided that a row from before the upgrade keeps no waiter.

## Decisions

- **`PauseWaiter` and `PauseEnd` live in `src/contracts/chat-parts.ts`.** A client imports the contracts and never the workflows, thus the part type cannot import `PauseEnd` from `pause.ts`. `pause.ts` imports both types from the contracts. The barrels export them beside `PausePart`. `PauseWaiter` is `{ kind: "turn" } | { kind: "sub-agent"; agentId } | { kind: "step"; stepId } | { kind: "synthesis" } | { kind: "run" } | { kind: "profile" }`.
- **`{ kind: "run" }` names the charge gate of a run.** The issue example has no kind for it. The run workflow waits there before any step starts, thus neither `step` nor `synthesis` is true.
- **`PausePart` stays one flat type.** `waiter` is optional, by the decision of the user. `cause` and `pausedAt` become required, because each emit now has them. `attempt` stays absent for `running`, and `retryAt` stays for `retrying` only. `endedAt` and `end` are optional fields that only the state `running` carries. The end part always has `end`, and it has `endedAt` except after the replay that the risks name. A union keyed by the state is more exact, but it changes each consumer of the part. The flat type obeys the style of its neighbors. `PausePartSchema` mirrors the type.
- **`PauseScope` takes a required `waiter`.** Each call site gives its waiter. The run workflow builds two pauses over the same workflow: one with `run` for `validateAndInit`, and one with `synthesis` for `synthesizeFindings`. To build a pause is not a DBOS operation, thus the two pauses need no patch.
- **`SubAgentPauses` takes the waiter.** `registerSubAgent` gives `{ kind: "sub-agent", agentId: name }`, the same name as the `agentId` of the source of the child frames.
- **The lease workflow derives its waiter from its input.** A lease of a profile gives `profile`. A lease of a run gives the step of `input.session.runFrame.stepId`, which `SpawnSession` makes required. The input of the lease workflow does not change, thus a lease workflow that runs at the upgrade also names its step. The alternative, a `waiter` field in `LeaseBinding` and in the input, gives no waiter to such a lease workflow.
- **The row gets a nullable `waiter JSONB` column.** A new migration adds it and deletes no row. `recordPause` writes it on the insert and on the update. The row schema reads `null` as no waiter, thus `PauseRecord.waiter` and `PausedWorkflow.waiter` are optional.
- **`pausedAt` is the value of the existing `DBOS.now()` call.** The start part and the part of a hold carry it. The hold keeps the start of the wait, the same as its row.
- **`endedAt` comes from the existing `pause.clear` step.** The step clears the row and returns the time of the clear. A recovery replays the output of the step, thus the time stays the same. A new `DBOS.now()` after the wait is a new body operation, thus a patch is necessary. `end` is the value that the wait already returns.
- **The mirror keeps the last row that it read.** It mirrors the waiter and `pausedAt` of each row. The wait sees the end when the row is gone, or when its event arrives after a mirrored pause. Then it emits the end part with the cause, `pausedAt`, and the waiter of the last row. Its `endedAt` is the clock of the wait when it sees the end. A lease workflow pauses only through `pauseAtGate`, with the cause `host`, thus its wait is always in `paused`. Its wait has no stop signal, thus the mirrored `end` is always `resume`. A stop of a lease cancels the lease workflow, and the mirror emits no end part, the same as today. A wait that read no row emits no end part, the same as today.
- **The recorder admits each non-transient part whose consumer is the conversation.** The filter drops its emitter condition. `data-pause` is the one such part that a workflow emits, thus no other part changes. The stored vocabulary gets the key `pause` in `ConversationUIData` and in `dataSchemas`. It also gets a `StoredSourcePart` arm, a `STORED_SOURCE_TYPES` entry, and a case in each switch. The registry entry stays `workflow`, because the run stream also carries the part.
- **The interruption note of an aborted turn stores the pause parts of the open round.** A recorder read gives only the `data-pause` parts of the open round, in one assistant message with the id of the round, or nothing. To store the whole open round also stores its partial text and its unfinished calls, and that changes each aborted turn.
- **`list` takes an optional analysis id, and each of its reads takes the same option.** With no id, the pause rows, the live turns, the `running` runs, and the `running` profiles of each analysis come from one statement each. Then one `DBOS.listWorkflows` call tests the workflows. Each item takes its analysis id from its source row. Extend the existing reads where they live. A new `listAll` method is the alternative, but the issue asks to extend `list`, and `stop` keeps its call `list(session.scope.analysisId)`.

## Risks / Trade-offs

- [A frame from before the upgrade has no `pausedAt`] → The schema refuses such a frame, and a reader drops it. The end part of a wait that the upgrade met comes from the new code, thus it passes. Only `waiter` is optional, by the decision of the user.
- [A wait can complete `pause.clear` before the upgrade and emit after it] → Its end part then has no `endedAt`. The window is one step long, and it occurs only at the upgrade.
- [A mirrored end time can be late by one wait slice of 10 seconds] → The spec names the time when the wait saw the end. The end of the run stream is not stored in a transcript.
- [A resume at the deadline of a lease wait in `retrying` reads as `retry`] → The two ends give the same effect. A resume in `retrying` is "retry now".
- [A turn that waits two times keeps one stored part] → The part shows the last wait, in the position of the first wait. The part stays keyed by the workflow id, as the spec states. A key for each wait changes the reconciling contract of each reader.
- [A list with no analysis id reads the active work of each analysis] → The live work limits the reads, not the history. A row leaves each set when its work ends.
- [A stop from a different process cancels the turn workflow] → That stop writes no end part and stores no round, the same as today. A host with one process, such as the cli server, stops each turn in the process that runs it.

## Migration Plan

The migration adds the nullable column only. A row from before the upgrade keeps no waiter until its wait ends. The next pause of the workflow writes a new row with a waiter. To roll back, deploy the earlier harness. The earlier code does not read the column.
