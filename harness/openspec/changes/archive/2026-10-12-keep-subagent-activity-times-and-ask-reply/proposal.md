# Proposal

## Why

Issue #648: three facts that a user saw live are lost from the stored records. The display recorder drops each frame of a sub-agent, thus a reloaded turn shows no sub-agent tool call. Each step and the data profile write their activity under one reconciling id with no time. Thus a client that connects late gets only the last line. A settled `data-ask` says `resolved` for `once` and for `always`, although the ledger keeps the reply. The consumer (inflexa-ai/himmel#71) shows the sub-agent calls as a list. It shows the profile as a checklist with a time on each line, and a settled ask as "Always approved".

## What Changes

- `EventSource` gets an optional `invocationId`: the id of the tool call that runs the loop. The loop stamps it on each event from `RunAgentOptions.invocationId`. `toChatFrame` copies it, and `EventSourceSchema` accepts it.
- A new persisted, reconciling conversation part `data-subagent-activity` `{ id, toolCallId, entries, dropped }`. Each entry is one tool call of a sub-agent: `{ agentId, callPath, tool, label?, startedAt, endedAt?, outcome? }`. The label is the redacted one-line detail of the call, never its input, its output, or any text of the sub-agent. A fixed cap of 200 entries bounds one part, and `dropped` counts the rest.
- A pure, browser-safe tracker beside `applyChatFrame` (`createSubAgentActivityTracker`) maps each nested invocation id to its root tool call and gives the `data-subagent-activity` part frame. The display recorder and a live host use the same tracker, thus a live turn and its reload show the same list.
- `data-step-activity` gets `at` (ISO 8601) from the checkpointed clock of the workflow.
- A new persisted, non-reconciling run part `data-activity-entry` `{ id, runId, stepId, phase, activity, at }`. The sandbox step and the data profile write one for each activity emission, after the `data-step-activity` part. The run-event fold keeps each entry.
- A settled `data-ask` gets `reply?: "once" | "always" | "reject"`, from the ledger row. The reject feedback stays out of the part.
- No model-facing record changes: nothing new goes into the model messages, a tool result, or a per-turn context record.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-frame-translation`: the sub-agent activity tracker and the copy of `invocationId` in `toChatFrame`. The recorder records the part of the tracker, and the live path of the parity requirement uses the tracker.
- `conversation-display-storage`: the recorder keeps the tool calls of a sub-agent as entries of `data-subagent-activity`, and still excludes the display parts and the text of a sub-agent.
- `harness-agent-loop`: a nested loop stamps its invocation id on the source of each event. The stored record of a sub-agent holds per-call entries only, never its messages.
- `run-event-stream`: each activity emission carries its time and leaves a `data-activity-entry` that the fold keeps.
- `data-profile-observation`: the profile writes the time and the history entries, and a late subscriber gets the current activity and the history.
- `tool-approval`: the terminal `data-ask` part carries the reply kind.

## Impact

- Contracts: `contracts/chat-events.ts`, `contracts/chat-parts.ts`, `contracts/part-registry.ts`, `contracts/chat-frame.ts`, a new `contracts/subagent-activity.ts`, the schemas, and the barrels (`contracts/index.ts`, `contracts/schemas/index.ts`, `src/index.ts`).
- Loop: `loop/types.ts` and `loop/run-agent.ts` (source stamping only).
- Memory: `memory/conversation-display-recorder.ts`, `memory/conversation-display-storage.ts`.
- Workflows: `workflows/sandbox-step.ts`, `tasks/data-profile-activity.ts`, `tasks/data-profile.ts`. The added `DBOS.now()` and `writeStream` calls change the function-id sequence of these bodies.
- Approval: `tools/approval/gateway.ts`.
- The CLI is not changed. The two new `ChatPart` members make its exhaustive part switch (`cli/src/tui/layout/message_block.tsx:207-288`) fail the cli typecheck until the CLI adds the two cases.
