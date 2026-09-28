## Why

A live part frame carries the payload of its emitter, and nothing checked it. Thus each consumer read the part as `unknown` and checked each field again. The stored transcript also lost the plan step fields that the card shows, because the plan step schema did not list them.

## What Changes

- `checkChatPart` checks a part frame against the schema of its type, one time, where it arrives. A type that the registry does not know passes unchanged.
- The display recorder uses `checkChatPart`.
- `PlanStep` and its schema list the optional fields `track`, `step_type`, `acceptance_criteria`, `constraints`, `caveats`, and `resources.gpu`.
- `reconcileKey` and `upsertPart` hold the one reconcile rule. `applyChatFrame`, the replay, and the run-event fold use them.
- The root barrel exports the message types and each chat part type.

## Capabilities

### Modified Capabilities

- `chat-frame-translation`: a part frame is checked where it arrives.

## Impact

- `harness/src/contracts/`, `harness/src/memory/`, `harness/src/execution/run-event-parts.ts`, `harness/src/index.ts`.
- The CLI checks each live part at receipt, and its readers take the harness part types.
