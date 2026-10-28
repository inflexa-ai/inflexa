# Proposal

## Why

A host shows the durable work of an analysis: a chat turn, a run, and a data profile. Today the harness gives only the paused work, through `CoreRuntime.pausedWork`. A host cannot find a work that runs, and it has no single stop. The stop of a turn and the cancel of a run have different entry points, and the harness has no stop of a data profile.

The stream of a turn also has a gap. The turn stores the user message only with its first round. A reader of the stream before that round has no source of the user message. An example is a client that attaches again to a turn that paused on its first model request. The `chat-turn-stream` spec says that the fold of a second read equals the fold of a live read, but that client cannot show the user message.

## What Changes

- **BREAKING:** `CoreRuntime.work` replaces `CoreRuntime.pausedWork`. The surface `WorkSurface` has `list`, `stop`, `resume`, and `hold`. The module `app/work.ts` replaces `app/paused-work.ts`.
- `list(analysisId)` gives each active work of the analysis, not only the paused work. Each item has `waiting`, which is empty for a work that runs.
- `stop(session, workId)` ends one work in each state. A turn stops through `chatTurns.stop`. A run cancels through a run canceler that the runtime makes. A profile stops through the new `stopDataProfile`.
- `resume` and `hold` do not change.
- **BREAKING:** these types change their names:
  - `PausedWorkKind` becomes `WorkKind`.
  - `PausedWork` becomes `Work`.
  - `PausedWorkSurface` becomes `WorkSurface`.
  - `PausedWorkResume` becomes `WorkResume`.
  - `PausedWorkHold` becomes `WorkHold`.
- The new type `WorkStop` gives the result of a stop. `PausedWorkflow` keeps its name.
- The new `stopDataProfile` cancels the profile workflow, deletes its pause rows, and fails its row with the error `DATA_PROFILE_STOPPED`. A retry can start from the failed row.
- The new state query `queryTurnsOfAnalysis` gives the turn that holds each thread of an analysis.
- **BREAKING:** `MessageStartEvent` is a union by `role`. The `user` variant has the necessary field `text`, which holds the sanitized user text. The schema refuses a `user` frame with no `text`.
- `applyChatFrame` adds the user message from a user `message-start`, when no message has that id.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `work-pause`: the host surface lists each active work, and it stops each kind of work. The surface has a new name.
- `chat-frame-translation`: a user `message-start` carries the user text, and `applyChatFrame` adds the user message from it.
- `chat-turn-stream`: the stream of a turn carries the user message.
- `data-profile-init`: a host stops the profile, and a cancel of the profile workflow is not a terminal path of the body.

## Impact

- Harness:
  - `app/work.ts` replaces `app/paused-work.ts`
  - `runtime/assemble.ts` and `index.ts`: the surface `work`, its run canceler, and the exports
  - `tasks/data-profile.ts`: `stopDataProfile` and `DATA_PROFILE_STOPPED`
  - `state/active-turns.ts`: `queryTurnsOfAnalysis`
  - `contracts/`, `loop/types.ts`, `memory/conversation-display-recorder.ts`, and `app/chat-turn-workflow.ts`: the user `message-start`
- CLI: the CLI changes its use of `pausedWork` to `work`, and it keeps only the paused items of `work.list`.
- Stored streams: the stream of a turn that started before this release has a user `message-start` with no text. The new schema refuses that frame.
