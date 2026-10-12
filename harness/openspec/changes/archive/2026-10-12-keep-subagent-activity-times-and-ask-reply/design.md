# Design

## Context

See proposal.md for the motivation. The current state that shapes the approach:

- Each thread stores two projections. The model reads only `message_envelope` (`memory/thread-history.ts:549-550`). The transcript replay alone reads the display envelope (`memory/conversation-display-replay.ts:41-52`). Display data adds no token (conversation-display-storage spec, "Model and display histories are separate projections").
- The display recorder builds each round with `toChatFrame` and `applyChatFrame`, and it drops each frame of a sub-agent (`memory/conversation-display-recorder.ts:120-129`). `toSource` copies only `agentId` and `callPath` (`contracts/chat-frame.ts:22-24`).
- `EventSource` has two declarations: the wire type (`contracts/chat-events.ts:22-25`) and the loop type (`loop/types.ts:52-55`). The loop builds one source for each run (`loop/run-agent.ts:351-354`). `RunAgentOptions.invocationId` exists (`run-agent.ts:226-236`), and each sub-agent tool passes `ctx.invocationId` (`tools/research/generate-plan.ts:1187`, `tools/research/generate-analogy-report.ts:247`, `tools/research/literature-reviewer.ts:126`). The data profile passes its workflow id (`tasks/data-profile.ts:750`).
- The loop emits each `tool-started` of a round before dispatch, and each `tool-finished` after the whole round settles (`run-agent.ts:815-822`, `544-578`). `durationMs` is measured around the call itself. Step-mode calls run in parallel, and inline-mode calls run one after another after them (`run-agent.ts:1159-1180`). Only report tools use the inline mode.
- The round sink runs at the start of each request (`run-agent.ts:712`). Thus a root tool call and all the activity of its sub-agent end inside one round.
- The sandbox step and the data profile write `data-step-activity` under one reconciling id with no time (`workflows/sandbox-step.ts:573-584`, `tasks/data-profile-activity.ts:114-127`). The run-event fold keeps the newest part of each reconciling id and each part of other types (`execution/run-event-parts.ts:54-68`). In a workflow body, `DBOS.now()` is a checkpointed step, and `DBOS.writeStream` takes a function id. A replay skips a recorded write.
- The ask gateway emits the terminal `data-ask` with the ledger status only (`tools/approval/gateway.ts:126-128, 152-163`). `selectAskResolution` already gives the reply (`tools/approval/queries.ts:110-120`).

## Goals / Non-Goals

**Goals:**

- A reloaded turn shows each tool call of a sub-agent under its root tool call, with no model token cost.
- A live host can build the same list with the same rules.
- A run stream that a client opens late gives each activity line with its time.
- A settled ask shows its reply kind.

**Non-Goals:**

- No change to the CLI. The CLI typecheck fails at `cli/src/tui/layout/message_block.tsx:286` until the CLI adds the two new cases.
- No time on `data-synthesis-progress`, and no part for an ask that a standing grant approves (`tools/approval/gateway.ts:95-98`). Both stay open in `tmp/claude/SESSION.md`.
- No change to `applyChatFrame`, to `callPath`, to the usage record key, or to the model-facing records.

## Decisions

### D1 (user): Display envelope and run stream only

Each new fact goes into the display envelope or a run stream. Nothing goes into a model message, a tool result, or the per-turn context record (`app/run-activity.ts:1-4`). The new `invocationId` goes only into the source of an event, and the source never reaches a model message. Alternative rejected: a summary of the sub-agent calls in the tool result. That costs tokens on each later request.

### D2 (user): `data-activity-entry`, a new non-reconciling part

Each activity emission writes `data-step-activity` (with `at`) and then one `data-activity-entry` with the same phase, activity, and time. The registry entry is `{ emitter: "workflow", consumer: "sidebar", transient: false, reconciling: false }`. Thus the batch fold and `pipeFoldedRunEvents` deliver each entry with no code change. Alternative rejected: read the `data-loop-event` rows (`workflows/sandbox-step.ts:671`). They hold raw tool inputs and each text delta, they are not a contract, and the data profile writes none.

- The entry id is `stepPartId("activity-entry", runId, stepId)` plus `-<seq>`. `seq` is a counter local to the body. It advances before the two writes, thus a failed write cannot shift a later id. Each emission runs on the body path, never inside a step. Thus a recovered body counts the same emissions again and gives the same ids.
- One `DBOS.now()` for each emission gives the same `at` to the two parts. The data-profile emitter stays free of DBOS: it takes an injected `now: () => Promise<number>`, and the body passes `() => DBOS.now()`. This is the pattern of `tasks/derive-table-exec.ts:79`. Outside a workflow, `DBOS.now()` gives the wall clock.
- The two writes fail independently. Each failure is logged, and neither fails the step.
- `at` is optional in the type and the schema. A run stream that an older harness wrote keeps parts with no time, and the run-stream reader does no payload check (`execution/run-event-parts.ts:32-38`). Each emitter of this version always sets `at`. The same convention covers `ToolCallPart.durationMs`.
- No cap. The issue says that the `maxSteps` of a step bounds the count, but the sandbox step does not get the `maxSteps` of the plan. The real bound is the iteration cap of the agent (`agents/sandbox/shared.ts:333`, default 200), the wrap-up requests (`run-agent.ts:250`), and the salvage of the profile. Multiply that by the calls of each round, and add the fixed phases. Each entry is its own stream row, not one record that grows. A sandbox step already writes one `data-loop-event` row for each loop event.

### D3 (user): `invocationId` on `EventSource`

Both `EventSource` declarations and `EventSourceSchema` get `invocationId?: string`. `openLoop` adds it to its one source when `opts.invocationId` has a value (a conditional spread, never an `undefined` key). `toSource` copies it with the same rule. The logger fields and `callPath` do not change.

The tracker maps a nested invocation id to the root tool call through the `tool-started` frames that it sees. Each `tool-started` comes before the dispatch of its call, thus the mapping exists before any frame of the nested loop. A frame with no `invocationId` below the root, for example a frame of the compaction exchange (`loop/continue-agent.ts:66-71`), maps to nothing and changes nothing.

The map key is the call path of the loop that made the call, plus the call id. A nested frame looks up its parent with `callPath.slice(0, -1)` and `invocationId`. Thus a call id that two loops of different agents reuse cannot join two lists. The rule "Code MUST NOT branch on `callPath`" (`CONTEXT.md:258-260`) permits the source stamp and sub-agent lineage. This key is sub-agent lineage of a display consumer, the same read as `isRootFrame`, and no harness control flow changes on it.

Alternatives rejected by the user: a root-id stamp that the loop carries down (option 2), a guess of the newest open call (option 3, the CLI heuristic at `cli/src/tui/hooks/conversation.ts:343-384`), and a unique `callPath` segment (option 4: `callPath` feeds the usage keys, the billing tags, and the provenance).

### The tracker is a contracts function beside `applyChatFrame`

`contracts/subagent-activity.ts` exports `createSubAgentActivityTracker()` and `SUBAGENT_ACTIVITY_MAX_ENTRIES = 200`. The tracker has one method, `track(frame, nowMs): ChatPartFrame | null`. It holds the call map and one record for each root tool call. It gives a new `data-subagent-activity` part frame with no source after each change. The module imports only types from outside `contracts/`.

The display recorder and the live path of the parity test call it beside `applyChatFrame`, and they apply each part that it gives. The recorder sends the part through `checkChatPart` and `applyChatFrame`, the same as each other conversation part. Thus the recorder holds no rule of its own. The part reconciles by id. Thus its first copy sits at the end of the round parts, after the root tool-call parts. Each update replaces it there.

Alternatives considered:

- A collector private to the recorder that inserts the part directly after the root tool-call part. Rejected: it gives the recorder its own placement rule (chat-frame-translation spec, "The display recorder uses the translation path"). Also, a live host could not build the same list, and the parity test would need a new known difference.
- A part that the harness emits on the live wire. Rejected: each update sends the whole list again to each host, and the recorder becomes an emitter.

The `index.ts` barrel, `contracts/index.ts`, and `contracts/schemas/index.ts` export the tracker, the two new part types, and their schemas. The CLI can drop its newest-open-call heuristic later.

### The shape of `data-subagent-activity`

```ts
interface SubAgentActivityEntry {
    agentId: string;
    callPath: string[];
    tool: string;
    label?: string;          // the frame detail: normalized, redacted, 120 code points at most
    startedAt: string;       // ISO 8601
    endedAt?: string;        // ISO 8601, absent while in flight and for incomplete
    outcome?: ToolCallOutcome; // absent while in flight; required when stored
}
interface SubAgentActivityPart {
    type: "data-subagent-activity";
    id: string;              // stepPartId-like: `subagent-activity-${toolCallId}`
    toolCallId: string;      // the root tool call
    entries: SubAgentActivityEntry[];
    dropped: number;
}
```

- The registry entry is `{ emitter: "conversation", consumer: "conversation", transient: false, reconciling: true }`.
- `label` takes the `tool-finished` detail when the frame has one, else the `tool-started` detail. This is the merge rule of the tool-call part (`contracts/chat-frame.ts:148-165`). The tracker never reads `input`.
- `endedAt` is `startedAt + durationMs` when the finish has `durationMs`, else the receipt time of the finish. The receipt time of a finish is the end of the round, not the end of the call. Thus the measured duration gives the correct end of a parallel call.
- Cap: 200 entries, the first ones in start order, and `dropped` counts each later call. A plan costs two or three calls (`tools/research/generate-plan.ts:69-81`). The analogy research runs at most 40 iterations. Thus 200 shows each call of a normal run. At about 300 bytes for each entry, one part stays near 60 KB at most. The transcript read parses each display envelope with no paging (`memory/thread-history.ts:613-633`), thus the cap bounds that cost.

### Storage of the part

`memory/conversation-display-storage.ts` adds the key `subagent-activity` to `ConversationUIData` and `dataSchemas`. The stored schema requires `outcome` on each entry, the same as `ToolCallDisplaySchema`. `conversationDisplayPart` closes each entry with no outcome as `incomplete`, with no `endedAt`, at the boundary where the lifetime changes. The display schema version stays 1: the key is new, and an older reader drops it with a warning (`dropUnrenderableDataParts`).

### The recorder

`createConversationDisplayRecorder` takes `now?: () => number`, and the default is `Date.now`. The chat turn is a regular HTTP request, not a workflow, thus the wall clock is correct. `record` gives each frame to the tracker before the root filter, and it applies the part that the tracker gives through `durableConversationType`, `recordedPart`, and `apply`. The tracker lives for the turn.

### The ask reply

`emitAskPart` takes an optional reply kind. The terminal emission after the poll gives `once` or `always` for `resolved`, with the narrowing of `settle` (a malformed reply gives `once`). It gives `reject` for `rejected`. The abort, the expiry, the vanished row, and the pending emission give none. `AskPartSchema` gets `reply: z.enum(["once", "always", "reject"]).optional()`. Thus `checkChatPart` keeps it, and the stored `ask` key inherits it through `omit`.

## Risks / Trade-offs

- [The clock read of an emission sits outside the swallowed-write `try`, thus a rejected `DBOS.now()` stops the body.] → The rejection is a cancellation, which must reach DBOS unchanged, or a failure of the system database, which stops the workflow at its next durable step anyway.
- [The new `DBOS.now()` and `writeStream` calls change the function-id sequence of the two bodies.] → DBOS recovers a workflow only under its own `applicationVersion` cohort (harness-durable-runtime spec). The change adds no new constraint beyond any other change of a body.
- [An inline-mode tool of a sub-agent gets an `endedAt` that is early by its wait in the queue.] → No sub-agent has an inline tool. Inline mode is only in the report tools (`tools/define-tool.ts:306` defaults to step).
- [A live pipe can deliver an entry before its held `data-step-activity` (`execution/run-event-parts.ts:78-117`).] → The entries keep write order among themselves. The run-event-stream spec tells a consumer to read the activity part as the current value.
- [Two concurrent sub-agents of one type can join their lists if a server reuses a call id.] → The map key holds the call path. Providers give unique ids, and the usage record key already relies on the same ids.
- [The cli typecheck fails until the CLI adds the two part cases.] → The CLI change is a separate step of the developer.
- [Each update of a sub-agent part copies and validates the entry list.] → The cap bounds each copy at 200 entries.
- [The cap bounds one part, not one turn: a turn holds one part for each root call that runs a sub-agent.] → The iteration cap of the root agent bounds the root calls of a turn. Each part stays bounded.
- [The `reply` field is optional on each status, thus the type admits a pair such as `pending` with `always`.] → One function in the gateway derives `reply` from the status, and the tool-approval spec lists the valid pairs. A schema refinement is not used, because zod 4 refuses `.omit` on a refined object, and the stored `ask` key uses `.omit`.
