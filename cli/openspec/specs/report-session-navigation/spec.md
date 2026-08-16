# report-session-navigation Specification

## Purpose
How a user moves between an analysis conversation and the report sessions that it spawned. It covers the remappable keybind pair, the report picker of the palette, the entry in the transcript, and each dead-direction notice. The code lives across the keymap, the chat shell, the command registry, two hooks, and two components.
## Requirements

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

### Requirement: The chat shows an entry point into each report child at its anchor
The chat MUST show an openable entry for each report child of the open conversation. The entry MUST sit below the turn that asked for the session. The entry MUST open that child in place.

The entry MUST derive from the thread listing alone. It MUST NOT read a tool result, and no new harness data part is necessary. Thus a child that a different host spawned appears the same way.

The listing MUST read again after the turn that spawns a child settles. The open thread does not change at a spawn. Thus a read that tracks the open thread alone shows nothing until the user leaves the conversation.

The anchor is a store sequence number, and the loaded transcript holds no such number. The load reads each stored message with its sequence number, and the conversion to the display messages drops it. Thus the load path MUST pair each sequence number with the identity of the message that its row ends on. The pair MUST hold an identity and not a position, because a live append drops a message off the front at the cap.

The anchor names the last stored row BEFORE the turn that asked for the session. The spawn runs inside that turn, and the append of the turn lands after the spawn. Thus a placement at the anchor paints the entry above the words that asked for the report. The entry MUST instead sit after the reply of the turn that crosses the anchor: the first assistant message at or past the first pair above the anchor. When no assistant message sits at or past that pair, the entry MUST render at the end of the mounted transcript. The rule holds on a live transcript and on a reloaded one alike.

Two states still reach the end position, and both belong there. An anchor past every loaded pair is one. The other is a session that the newest turn spawned, before any of its rows load.

The transcript mounts the newest turns alone, thus an anchor below the mounted window is a normal state. The entry MUST then render at the top. A pair whose message the mounted window no longer holds MUST read the same way. A listing failure MUST show no entry, and it MUST NOT break the transcript. An archived child MUST show no entry, because the listing reads the live children alone.

#### Scenario: An entry sits below its request

- **WHEN** the open conversation holds a report child whose anchor names a loaded position
- **THEN** the entry renders after the reply of the turn that crossed the anchor, below the request

#### Scenario: A reloaded transcript keeps the entry below the request

- **WHEN** the transcript reloads after a turn that spawned a report child
- **THEN** the entry renders after the reply of that turn, and never above the message that asked

#### Scenario: A session that a turn spawns gets its entry

- **WHEN** a turn of the open conversation spawns a report child and that turn settles
- **THEN** the transcript shows an entry for that child, and the open thread does not change

#### Scenario: The entry opens the child

- **WHEN** the user opens the entry
- **THEN** the chat swaps onto that report child in place

#### Scenario: An anchor past the loaded transcript renders at the end

- **WHEN** the anchor of a report child names a position past the loaded transcript
- **THEN** the entry renders at the end, and nothing throws

#### Scenario: A session that the newest turn spawned sits below the request

- **WHEN** the newest turn of the open conversation spawns a report child, and none of its rows are loaded
- **THEN** the entry renders at the end of the mounted transcript, below the request that asked for the report

#### Scenario: An anchor below the mounted window renders at the top

- **WHEN** the anchor of a report child names a position older than the mounted window
- **THEN** the entry renders at the top, and nothing throws

#### Scenario: A failed listing leaves the transcript whole

- **WHEN** the listing of the report children fails
- **THEN** the transcript renders with no entry, and no error reaches the user as a crash

#### Scenario: An archived child shows no entry

- **WHEN** a report child of the open conversation is archived
- **THEN** the transcript shows no entry for that child, and each other child keeps its entry

