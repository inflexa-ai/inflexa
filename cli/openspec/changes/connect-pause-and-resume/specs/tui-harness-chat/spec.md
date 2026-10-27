## ADDED Requirements

### Requirement: A paused turn docks a pause prompt

When the stream of a turn gives a `data-pause` frame with the state `retrying` or `paused`, the TUI MUST dock a pause prompt above the chat bar. The prompt MUST take the form of the docked ask prompt (see the `tui-ask-approval` capability). It MUST give the cause in words. It MUST also give the reason of the host for the cause `host`, and the remedy of the server for the cause `credential`. In `retrying`, it MUST give the attempt and the time of the next retry.

The prompt MUST give two actions on focus-gated keys: resume and stop. In `retrying`, the label of resume is "retry now". Resume MUST send `POST {A}/paused-work/:workId/resume` with the turn id. Stop MUST send the abort of the turn. A frame with the state `running` MUST remove the prompt.

A paused sub-agent of the turn MUST dock the same prompt, because the resume of the turn also resumes it. The design gallery MUST exhibit the prompt in its two states.

#### Scenario: A billing pause asks the user

- **GIVEN** a turn whose model request fails with a `suspend` error with the reason `payment_required`
- **WHEN** the TUI gets the `data-pause` frame
- **THEN** the prompt shows the reason `payment_required`, and the actions resume and stop

#### Scenario: Retry now ends a wait of the timer

- **GIVEN** a turn that waits in `retrying` with the attempt 2
- **WHEN** the user pushes the resume key
- **THEN** the TUI sends the resume, and the prompt goes at the frame `running`

#### Scenario: A stop of a paused turn

- **WHEN** the user pushes the stop key of the prompt
- **THEN** the turn ends as aborted, and the chat returns to idle

### Requirement: The TUI shows the paused work of the open analysis

At the open of an analysis and at each poll tick, the TUI MUST read the paused work of the analysis. The sidebar MUST mark a paused run and a paused profile, and their detail dialogs MUST give the cause. A palette command MUST list the paused work of the analysis in a select dialog, and it MUST resume the item that the user selects.

A paused turn of the open thread that the TUI does not stream MUST make the TUI read the turn again. Then the TUI docks the pause prompt.

#### Scenario: A paused run after a restart

- **GIVEN** a run whose step waits in `paused`, and a TUI that starts
- **WHEN** the TUI opens the analysis
- **THEN** the sidebar marks the run as paused, and the palette command lists it

#### Scenario: A paused turn after a restart

- **GIVEN** a turn of the open thread that waits in `paused`
- **WHEN** the TUI opens the thread
- **THEN** the TUI reads the turn again, and it docks the pause prompt

## MODIFIED Requirements

### Requirement: Turn failures are observable

A failed turn MUST never be a dead end. The harness gives the failure of a turn as a scrubbed text and a machine code, for example `provider`. The harness MUST log the whole cause at error level in the log of the server, the one place where the whole value survives. The server MUST make the failure of a turn from that code and that text. The summary of the turn MUST give one message with the remedy that the server knows. It MUST give the text of the failure as a detail line. An append fault MUST be logged at warn.

The TUI MUST show the message in the failure banner, and it MUST keep the detail lines of the last turn failure. The TUI MUST give a details view on a leader key, with the standard results dialog. Which-key MUST name the key, and the banner MUST show a label from the live binding. The kept failure MUST clear when a new turn starts. A refusal before the turn opens and a broken stream carry no detail lines, thus the TUI MUST keep one line that states the reason.

#### Scenario: A structured cause renders readably everywhere

- **WHEN** a turn fails with a discriminated error object, for example a harness `ProviderError`
- **THEN** the banner shows the scrubbed text of the failure, never `[object Object]`, and the log of the server holds the complete structured cause

#### Scenario: The details view shows the whole failure

- **WHEN** the user pushes the error-details leader key after a failed turn
- **THEN** a dialog shows the detail lines of the failure

#### Scenario: A new turn clears the retained failure

- **WHEN** the user sends a new message after a failure
- **THEN** the banner and the kept failure reset, and the details view reports no recent turn error

#### Scenario: A refusal still explains itself

- **WHEN** the server refuses a turn because its thread is gone, and the user opens the details view
- **THEN** the dialog shows the line that states the reason, not an empty view
