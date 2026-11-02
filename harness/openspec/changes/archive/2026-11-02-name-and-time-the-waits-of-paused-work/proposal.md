# Proposal

## Why

The pause UI of a host must name the part of the work that waits. It must also keep a marker of the wait in the transcript, with its start, its end, and its cause. A workflow that waits more than one time keeps the marker of its last wait. Today a wait names only its workflow. The part that ends a wait holds only the state `running`, and the stored transcript does not keep the pause part. A host that shows paused work across analyses must also read each analysis one at a time.

## What Changes

- A new `PauseWaiter` contract names what waits: the turn, a sub-agent with its agent id, a step with its step id, the synthesis, the run at its charge gate, or the profile.
- Each pause row of `cortex_paused_work`, each `data-pause` part, and each `PausedWorkflow` of `WorkSurface.list` carry the waiter. The lease workflow of a step names the step of the lease. A row from before the upgrade has no waiter, thus the field is optional in the contract.
- Each `data-pause` part carries `pausedAt`, the start of the wait.
- The part that ends a wait keeps the cause and `pausedAt`, and it adds `endedAt` and `end` (`retry`, `resume`, or `abort`).
- The stored transcript of a turn keeps the `data-pause` part of the turn. Thus a reload shows the same marker.
- `WorkSurface.list` takes an optional analysis id. With no id, it gives the active work of each analysis. The count of its reads does not depend on the count of analyses.
- **BREAKING** for a typed consumer: `PausePart.cause` and `PausePart.pausedAt` become required.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `work-pause`: each wait names what waits, and the part of a wait keeps its start, its end, and its cause. `list` reads the work of each analysis.
- `conversation-display-storage`: the stored display keeps the `data-pause` part of the turn.

## Impact

- `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, `src/contracts/index.ts`, and `src/index.ts`.
- `src/workflows/pause.ts`, `src/app/work.ts`, `src/state/paused-work.ts`, and a new migration in `src/state/migrations/`.
- The pause call sites: `src/app/chat-turn-workflow.ts`, `src/runtime/assemble.ts`, `src/loop/sub-agent.ts`, `src/workflows/sandbox-step.ts`, `src/workflows/execute-analysis.ts`, `src/tasks/data-profile.ts`, and `src/sandbox/leases.ts`.
- The cross-analysis reads in `src/state/active-turns.ts`, `src/state/runs.ts`, and `src/state/data-profile.ts`.
- `src/memory/conversation-display-storage.ts`, `src/memory/conversation-display-recorder.ts`, and the transcript replay.
- The tests of each changed file.
- The cli consumes the new fields and the cross-analysis list in a separate cli change. That change adds `GET /api/v1/paused-work`.
