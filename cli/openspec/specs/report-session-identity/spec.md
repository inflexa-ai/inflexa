# report-session-identity Specification

## Purpose
How the shell marks the open report session, and how the user reads and copies the session id. It covers the footer scope word, the status-bar segment, the SESSION rail context line, and the two copy affordances. The code lives across the chat shell, the open-thread hook, the sidebar, and the command registry.
## Requirements

### Requirement: The footer names the session scope
The chat-bar footer MUST show a scope word beside the mode word, from the open-thread snapshot. A loaded `report` row reads `REPORT`, bold in the accent role. A loaded conversation row reads `ANALYSIS`, muted. An absent row reads `ANALYSIS` too, because a spawn writes a report row before the child opens. An unresolved snapshot shows no scope word, thus the footer never claims a scope that it does not know. The word arrives at the footer as data, and the footer keeps its no-domain-imports rule.

#### Scenario: A report session names itself

- **WHEN** the open thread loads as a report row
- **THEN** the footer shows `REPORT` beside the mode word, bold in the accent role

#### Scenario: A conversation reads as the analysis scope

- **WHEN** the open thread loads as a conversation row, or resolves to no row
- **THEN** the footer shows the muted `ANALYSIS`

#### Scenario: An unresolved snapshot shows no scope

- **WHEN** the row read of the open thread is in flight
- **THEN** the footer shows the mode word alone

### Requirement: The status bar names the report scope
The status bar of the chat MUST carry a scope segment while the open thread loads as a report row. The segment reads `report`, in the accent role, after the analysis subtitle. A conversation passes no segment. The segment arrives as a prop, and the status bar keeps its no-domain-imports rule.

#### Scenario: A report session shows the segment

- **WHEN** the chat renders while the open thread loads as a report row
- **THEN** the status bar shows the `report` segment after the analysis name

#### Scenario: A conversation shows no segment

- **WHEN** the chat renders while the open thread is a conversation
- **THEN** the status bar shows no scope segment

### Requirement: The SESSION rail names the report context
The SESSION section MUST add a context line while the open thread loads as a report row. The line names the kind, with the title of the parent conversation beside it. The parent row reads inside the open-thread refresh, under the same generation guard. A failed or absent parent read keeps the kind and drops the title, because absence is a normal condition.

#### Scenario: The rail names the kind and the parent

- **WHEN** the open thread loads as a report row whose parent row resolves
- **THEN** the SESSION section shows the report kind and the parent title

#### Scenario: An unreadable parent keeps the kind

- **WHEN** the parent read fails, or the parent row is gone
- **THEN** the context line shows the kind alone, and nothing crashes

#### Scenario: A conversation shows no context line

- **WHEN** the open thread is a conversation
- **THEN** the SESSION section renders as before, with no context line

### Requirement: The full session id is copyable
A click on the SESSION id chip MUST copy the full thread id, through the shared clipboard writer, and a notice confirms the copy. The chip keeps its short form, because the rail cannot hold the 36 characters of the id. The palette MUST offer the command `session.copy-id`, with the title "Copy session id", in the Session category. The command copies the same id. It is offered only while a session is bound. The id lives in the workspace scope, thus no boot gate applies to the copy.

#### Scenario: A click copies the id

- **WHEN** the user clicks the SESSION id chip
- **THEN** the clipboard holds the full thread id, and a notice confirms the copy

#### Scenario: The palette copies the same id

- **WHEN** the user runs "Copy session id" with a session bound
- **THEN** the clipboard holds the full thread id of the open session

#### Scenario: No bound session offers no command

- **WHEN** no session is bound
- **THEN** the palette does not offer the copy command
