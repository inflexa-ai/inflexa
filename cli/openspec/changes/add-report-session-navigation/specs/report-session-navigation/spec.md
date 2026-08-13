## ADDED Requirements

### Requirement: A remappable keybind pair moves between a conversation and its report children
The TUI MUST declare two remappable command ids in `KEYBIND_DEFAULTS`. The ids MUST be `session.open-parent`, which opens the parent, and `session.open-report`, which opens a report child. A user MUST be able to override each id through `config.keybinds`.

The default value of each id MUST be one chord: `left` and `right`. Each binding MUST build the sequence of the leader chord and the resolved chord of its id. Thus the reachable key is `<leader> left` or `<leader> right`. The leader prefix MUST NOT ride the default value, because the resolution of a remappable id gives one chord and never a sequence. A ctrl-arrow MUST NOT be a default, because macOS binds it to its own window control and it never reaches the terminal there.

Each binding MUST carry a description and a group, thus the reachable-keys overlay documents the pair from the binding itself.

#### Scenario: The pair is remappable

- **WHEN** the configuration binds a different chord to either id
- **THEN** the leader and that chord run the flow, and the default chord no longer does

#### Scenario: The overlay documents the pair

- **WHEN** the user opens the reachable-keys overlay after the leader stroke
- **THEN** the overlay lists both bindings with their descriptions

### Requirement: The back keybind opens the parent conversation
The back flow MUST read the open thread. When that thread is a report child, the flow MUST swap the chat onto the parent thread of the child. The parent belongs to the same analysis. The swap MUST use the one session-open operation, thus nothing relaunches.

When the open thread is a conversation, the flow MUST raise a notice that names the reason, and it MUST leave the scope unchanged. A parent row that no longer resolves MUST raise a notice, and it MUST NOT throw.

#### Scenario: A report child opens its parent

- **WHEN** the open thread is a report child and the user runs the back flow
- **THEN** the chat swaps onto the parent conversation, and the transcript of the parent loads

#### Scenario: A conversation has no parent to open

- **WHEN** the open thread is a conversation and the user runs the back flow
- **THEN** a notice names the reason, and the open thread does not change

#### Scenario: An absent parent degrades

- **WHEN** the parent thread of the open report child resolves to no row
- **THEN** a notice names the absence, and nothing throws

### Requirement: The forward keybind opens a report child
The forward flow MUST read the report children of the open conversation, narrowed by the parent thread id and the `report` thread type. When exactly one child exists, the flow MUST swap the chat onto that child with no picker. When more than one exists, the flow MUST open a picker over them.

Each read of the report children MUST read the live children alone. An archive sets a tombstone over the whole subtree, thus an archived child leaves each of these surfaces on its own.

When the open conversation holds no report child, the flow MUST raise a notice. A report child MUST also raise a notice that names the reason. The thread tree under an analysis stays flat, thus a report child spawns none.

#### Scenario: One child opens with no picker

- **WHEN** the open conversation holds exactly one report child
- **THEN** the chat swaps onto that child, and no dialog opens

#### Scenario: Several children open a picker

- **WHEN** the open conversation holds more than one report child
- **THEN** a picker lists them, and the pick swaps the chat onto that child

#### Scenario: A conversation with no child gives a notice

- **WHEN** the open conversation holds no report child
- **THEN** a notice names the absence, and the open thread does not change

#### Scenario: A report child cannot go forward

- **WHEN** the open thread is a report child and the user runs the forward flow
- **THEN** a notice names the reason, and the open thread does not change

### Requirement: The palette lists the report children of the open conversation
The palette MUST offer the command `session.report-switch`, with the title "Switch report session", in the Session category. The command MUST list the report children of the open conversation. The listing MUST narrow by the parent thread id and the `report` thread type. The pick MUST swap the chat onto that child in place.

The command and the forward keybind MUST read one population. Thus the two surfaces cannot list different sets, and the picker of each is the same component over that one listing.

A report row MUST carry the shape of a session row of the switch picker. Its title and its last-activity stamp read the same, because a report child is a session. The thread type is the one thing that sets it apart, and the population of the picker already states that.

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

#### Scenario: A changed analysis refuses the dialog

- **WHEN** the open analysis changes while the listing reads
- **THEN** a notice names the change, and no picker opens

#### Scenario: A dispatch before the runtime is ready gives a notice

- **WHEN** the command runs by id and the boot state is not ready
- **THEN** a notice names the state, and the scope does not change

### Requirement: The chat shows an entry point into each report child at its anchor
The chat MUST show an openable entry for each report child of the open conversation. The entry MUST sit at the point of the transcript that the anchor of that child names. The entry MUST open that child in place.

The entry MUST derive from the thread listing alone. It MUST NOT read a tool result, and no new harness data part is necessary. Thus a child that a different host spawned appears the same way.

The anchor is a store sequence number, and the loaded transcript holds no such number. The load reads each stored message with its sequence number, and the conversion to the display messages drops it. Thus the load path MUST keep the sequence number of each loaded message beside the message that it opened. The entry MUST sit after the last loaded message whose sequence number is not greater than the anchor.

An anchor past the end of the loaded transcript MUST be a normal state, and the entry MUST render at the end. The transcript mounts the newest turns alone, thus an anchor below the mounted window is a normal state too. The entry MUST then render at the top of the loaded transcript. A listing failure MUST show no entry, and it MUST NOT break the transcript. An archived child MUST show no entry, because the listing reads the live children alone.

#### Scenario: An entry sits at the spawn point

- **WHEN** the open conversation holds a report child whose anchor names a loaded position
- **THEN** the transcript shows an openable entry for that child at that position

#### Scenario: The entry opens the child

- **WHEN** the user opens the entry
- **THEN** the chat swaps onto that report child in place

#### Scenario: An anchor past the loaded transcript renders at the end

- **WHEN** the anchor of a report child names a position past the loaded transcript
- **THEN** the entry renders at the end, and nothing throws

#### Scenario: An anchor below the mounted window renders at the top

- **WHEN** the anchor of a report child names a position older than the mounted window
- **THEN** the entry renders at the top, and nothing throws

#### Scenario: A failed listing leaves the transcript whole

- **WHEN** the listing of the report children fails
- **THEN** the transcript renders with no entry, and no error reaches the user as a crash

#### Scenario: An archived child shows no entry

- **WHEN** a report child of the open conversation is archived
- **THEN** the transcript shows no entry for that child, and each other child keeps its entry
