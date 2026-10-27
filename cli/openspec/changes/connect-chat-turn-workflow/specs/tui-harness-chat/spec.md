## MODIFIED Requirements

### Requirement: Turn failures are observable

A failed turn MUST never be a dead end. The harness gives the failure of a turn as a scrubbed text and a machine code, for example `credential`. The harness MUST log the whole cause at error level in the log of the server, the one place where the whole value survives. The server MUST make the failure of a turn from that code and that text. The summary of the turn MUST give one message with the remedy that the server knows. It MUST give the text of the failure as a detail line. An append fault MUST be logged at warn.

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

## ADDED Requirements

### Requirement: A lost stream reads the turn again

When the stream of a turn breaks, the TUI MUST read the turn again from its start, a maximum of three times. Before each read, the TUI MUST clear what the frames of the turn built. Thus each frame applies one time. When a read fails, the TUI MUST keep what it shows, and it MUST report the lost connection.

#### Scenario: A broken stream recovers

- **GIVEN** a turn whose stream breaks after its first text
- **WHEN** the server gives the turn again from its start
- **THEN** the assistant message holds the whole text one time, and the turn ends with no error

#### Scenario: A turn that the server forgot

- **WHEN** the stream of a turn breaks, and the server does not hold the turn
- **THEN** the TUI keeps what streamed, and the banner says that the connection to the turn was lost
