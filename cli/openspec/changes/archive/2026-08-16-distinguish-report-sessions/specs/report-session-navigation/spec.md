## MODIFIED Requirements

### Requirement: The palette lists the report children of the open conversation
The palette MUST offer the command `session.report-switch`, with the title "Switch report session", in the Session category. The command MUST list the report children of the open conversation. The listing MUST narrow by the parent thread id and the `report` thread type. The pick MUST swap the chat onto that child in place.

When the open thread is a report child, the command MUST list the children of its parent instead. That listing is the siblings of the open session, with the open session among them. The row of the open session MUST name that state, and a pick of it closes the dialog with no swap. Thus the picker inside a report session is never empty, and the family reads from either side.

The flow reads the open row first, because that row decides the family. When that read fails, the flow MUST refuse with a notice, and no picker opens.

On a conversation, the command and the forward keybind MUST read one population. Thus the two surfaces cannot list different sets, and the picker of each is the same component over that one listing.

A report row MUST carry the shape of a session row of the switch picker. Its title and its last-activity stamp read the same, because a report child is a session. Each row MUST also carry the short session id, and the detail line of the focused row MUST carry the full id beside its timestamp. The thread type is the one thing that sets a report child apart, and the population of the picker already states that.

The flow MUST read its listing before the dialog opens, and it MUST read the open analysis again after that read. When the analysis changed across the read, the flow MUST raise a notice and open no dialog. A listing failure MUST degrade to a notice.

The command MUST be offered only when an analysis is open and the boot state is ready. A dispatch by id under any other state MUST raise a notice, because a leader chord bypasses the offer predicate.

#### Scenario: The picker lists the report children

- **WHEN** the user opens the report-session command with the runtime ready
- **THEN** the picker lists the report children of the open conversation, and no conversation appears

#### Scenario: The command and the chord list one set

- **WHEN** the open conversation holds more than one report child
- **THEN** the picker of the command and the picker of the forward chord hold the same rows

#### Scenario: A pick swaps the chat

- **WHEN** the user picks a report session
- **THEN** the chat swaps onto that thread in place, and its transcript loads

#### Scenario: A report session lists its siblings

- **WHEN** the user opens the report-session command while a report child is open
- **THEN** the picker lists every report child of the parent conversation, and the open session is named

#### Scenario: A pick of the open session changes nothing

- **WHEN** the user picks the row of the open session
- **THEN** the dialog closes, and the open thread does not change

#### Scenario: An unreadable open row refuses the picker

- **WHEN** the read of the open row fails
- **THEN** a notice names the failure, and no picker opens

#### Scenario: The rows carry the ids

- **WHEN** the report picker renders
- **THEN** each row carries the short session id, and the detail line of the focused row carries the full id

#### Scenario: A changed analysis refuses the dialog

- **WHEN** the open analysis changes while the listing reads
- **THEN** a notice names the change, and no picker opens

#### Scenario: A dispatch before the runtime is ready gives a notice

- **WHEN** the command runs by id and the boot state is not ready
- **THEN** a notice names the state, and the scope does not change
