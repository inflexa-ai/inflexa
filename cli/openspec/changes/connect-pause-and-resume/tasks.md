## 1. The server

- [x] 1.1 Add `GET {A}/paused-work` and `POST {A}/paused-work/:workId/resume` over `pausedWork` of the harness, with the wire types in `src/api/` and the fetchers in `src/client/`. Give the remedy of the cause `credential` from the code that makes the remedy of a failed turn.
- [x] 1.2 Read a turn of the thread that the registry does not hold in `GET {T}/turns/:turnId/stream`, and keep the stream of a paused turn open.
- [x] 1.3 Count a paused turn and a run with a paused step in the busy gate.
- [x] 1.4 Remove each use of `suspended_insufficient_funds` and of the code `interrupted`.

## 2. The TUI

- [x] 2.1 Dock the pause prompt for a `data-pause` frame of a turn, in the form of the docked ask prompt, with resume and stop. Add the prompt to the design gallery in its two states.
- [x] 2.2 Read the paused work at the open of an analysis and at each poll tick. Mark a paused run and a paused profile in the sidebar. Add the palette command that resumes paused work.
- [x] 2.3 Read a paused turn of the open thread again, and dock its prompt.

## 3. The dev command

- [x] 3.1 Keep `inflexa run --plan` waiting on a paused run, and show the pause in its progress.

## 4. Verification

- [x] 4.1 Run the CLI typecheck, the lint, and the tests of the changed files against the linked harness.
