# Connect the pause and the resume of the harness

## Why

The harness pauses work now, and it does not fail the work, for a cause that a person or time can repair (the harness change `pause-and-resume-work`). A paused chat turn, run, or data profile waits until a client resumes it. The run status `suspended_insufficient_funds` and the failure code `interrupted` go. The local server and the TUI must show a pause, and they must let the user resume or stop the work.

## What Changes

- New routes: `GET {A}/paused-work` lists the paused work of an analysis, and `POST {A}/paused-work/:workId/resume` resumes it. The list gives the remedy that the server knows for the cause `credential`.
- The stream of a paused turn carries its `data-pause` frames, and it stays open while the turn waits. `GET {T}/turns/:turnId/stream` also reads a turn that a recovery runs and the registry does not hold.
- The TUI docks a pause prompt for a paused turn, in the form of the docked ask prompt. It gives the cause, the remedy, the next retry, and two actions: resume (or retry now) and stop.
- The poll of the TUI reads the paused work of the open analysis. The TUI marks a paused run and a paused profile, and a palette command resumes paused work.
- A paused run blocks a rename and a delete of its analysis, because its workflow is live.
- `inflexa run --plan` keeps waiting on a paused run, and its progress shows the pause.
- The CLI code drops each use of `suspended_insufficient_funds`.

## Capabilities

### Modified Capabilities

- `local-server`: the routes of paused work, the stream of a paused turn, the busy gate, and the poll.
- `tui-harness-chat`: the pause prompt of a turn, the paused work of the open analysis, and the failure example.
- `analysis-run-launch`: a paused run is not terminal.
- `prov-run-events`: the terminal run vocabulary loses `suspended_insufficient_funds`.

## Impact

- `src/server/routes/conversation.ts` and a route file for paused work: the new routes, and the read of a turn that the registry does not hold.
- `src/api/` and `src/client/`: the wire types and the fetchers of paused work.
- `src/tui/hooks/conversation.ts`, `src/tui/app.tsx`, `src/tui/hooks/sidebar_live.ts`, and the design gallery: the pause prompt, the poll read, and the marks.
- `src/types/events.ts`, `src/tui/hooks/run_completion.ts`, `src/tui/components/run_card_block.tsx`, `src/server/routes/runs.ts`, and `src/modules/harness/dev/run.ts`: the removed status.
