## ADDED Requirements

### Requirement: Remove session archives the conversation

The palette SHALL provide a "Remove session" command that archives the open conversation through the harness thread store's `archiveThread`, offered only when an analysis is open, a thread is bound, and the runtime is booted. Archiving stamps a tombstone: the row and every one of its messages stay in storage, and the thread merely stops appearing. The command's wording SHALL say so — it removes the conversation from view and states that the transcript is kept — because spending the app's strongest irreversibility ritual on an action that erases nothing would teach the user to distrust that ritual where it tells the truth.

The flow SHALL confirm against the conversation's own name, SHALL refuse when the bound thread changed while the confirmation was open, and after archiving SHALL land the user on whatever the analysis has left — its next most-recent live thread, else a freshly minted empty chat — unbinding the scope before that landing so a turn submitted across the gap cannot persist messages onto a thread that lists nowhere.

#### Scenario: Removing a session keeps its transcript

- **GIVEN** an open conversation with persisted messages
- **WHEN** "Remove session" is confirmed
- **THEN** the thread is archived, its messages remain in storage, and it no longer appears in the session picker

#### Scenario: The session changed under the confirmation

- **GIVEN** a remove confirmation opened for one conversation
- **WHEN** the bound thread changed before it was confirmed
- **THEN** nothing is archived and the user is told to reopen the command

#### Scenario: Removal lands on a surviving conversation

- **GIVEN** an analysis with more than one conversation
- **WHEN** the open one is removed
- **THEN** the chat rebinds to the analysis's next most-recent live conversation

### Requirement: Restore session recovers an archived conversation

The palette SHALL provide a "Restore session" command that lists the analysis's archived conversations and returns the chosen one to view via `unarchiveThread`. The listing SHALL come from `listThreads` widened with `includeArchived`, filtered to the rows carrying a tombstone — the only way to obtain an archived thread's id, since an archived thread is otherwise indistinguishable from an absent one. The command SHALL be offered only when an analysis is open and the runtime is booted, and SHALL show an empty state rather than a blank list when the analysis has nothing archived.

Restoring SHALL be a distinct command rather than a toggle inside the session picker: the picker composes a list whose items are fixed for the dialog's lifetime, so a toggle could not re-render it, and restoring is a deliberate, infrequent action that a separate entry makes discoverable by search.

The listing SHALL cover every archived conversation in the analysis, walking the widened set page by page rather than reading one page of it. The widened set is ordered by activity and archiving leaves that stamp where the last turn put it, so archived rows sort behind live ones and a single page can hold none of them — which would make the empty state assert that nothing was ever removed. Where the walk cannot complete — a page that fails to read, or a set that outruns the walk's bound — the command SHALL say the listing is incomplete, and a failed read SHALL NOT open the picker at all, since its empty state cannot be told apart from the truth.

#### Scenario: An archived conversation can be found and restored

- **GIVEN** a conversation that was removed earlier
- **WHEN** "Restore session" is run and that conversation is chosen
- **THEN** it is returned to view and appears in the session picker again

#### Scenario: Restore lists only archived conversations

- **GIVEN** an analysis with both live and archived conversations
- **WHEN** "Restore session" is opened
- **THEN** only the archived ones are listed

#### Scenario: Nothing to restore shows an empty state

- **GIVEN** an analysis with no archived conversations
- **WHEN** "Restore session" is opened
- **THEN** an empty-state message is shown rather than a blank list

#### Scenario: An archived conversation past the first page is still listed

- **GIVEN** an analysis whose archived conversations sort behind a full page of live ones
- **WHEN** "Restore session" is opened
- **THEN** the archived ones are listed, having been walked past the first page

#### Scenario: A listing that cannot be read opens no picker

- **GIVEN** a thread listing that fails to read
- **WHEN** "Restore session" is opened
- **THEN** no picker opens and the user is warned, so no empty state claims the analysis has nothing archived

### Requirement: The palette's provenance export signs before it writes

The palette's provenance export SHALL build the signature sidecar BEFORE writing the provenance document, and SHALL write neither when signing fails. Writing the document first leaves an unsigned provenance file on disk beneath a notice stating that provenance is never exported unsigned — a contradiction that the delete flow, which exports on the user's behalf without being asked, would turn from a rare inconsistency into a routine one.

#### Scenario: A signing failure writes nothing

- **GIVEN** provenance signing that fails
- **WHEN** the export runs
- **THEN** no provenance document and no sidecar are written, and the failure is reported

#### Scenario: A successful export writes both

- **WHEN** the export runs and signing succeeds
- **THEN** the provenance document and its sidecar are both written and the destination is reported

### Requirement: Delete session erases the conversation

The palette SHALL provide a "Delete session" command that hard-deletes the open conversation through the harness thread store's `purgeThread`, removing its metadata row and every one of its messages, offered under the same conditions as removal — an analysis open, a thread bound, and the runtime booted.

Unlike removal, this command SHALL spend the app's danger ritual: the confirmation SHALL carry danger chrome and require the user to type the conversation's name back. That ritual is reserved for actions that cannot be undone, and this is the first thread action that qualifies — removal keeps every message and is reversible through restore, which is exactly why it does not use it. The wording SHALL state that the transcript is erased and that this cannot be undone, so the two commands are never mistaken for each other.

The command SHALL refuse, before it reads the conversation or opens the confirmation, while a chat turn is streaming into it, and SHALL say why. The harness's thread store states this precondition and cannot enforce it, since it cannot observe a host's in-flight turns: a turn's messages are written with no foreign key to the thread row and tolerate that row being absent, so a turn committing after the purge lands rows attributable to no analysis and reachable by no later reclamation. The refusal SHALL be gated on the chat's own activity, not on the analysis-wide busy check the analysis delete uses — a running data profile or workflow writes no messages, and the flow only ever deletes the open conversation, so that check is already the right scope. Removal SHALL NOT carry this gate: a turn landing after an archive leaves its messages on a tombstoned row that restore returns intact.

The flow SHALL refuse when the bound thread changed while the confirmation was open, and afterwards SHALL land the user on whatever the analysis has left, unbinding the scope first — the same landing removal performs, for the same reason.

A deleted conversation SHALL NOT appear in the restore listing, because nothing remains to restore.

#### Scenario: Deleting a session erases its transcript

- **GIVEN** an open conversation with persisted messages
- **WHEN** "Delete session" is confirmed by typing its name
- **THEN** the thread row and every one of its messages are gone, and it appears in neither the session picker nor the restore listing

#### Scenario: Delete demands the name, remove does not

- **WHEN** "Delete session" is invoked
- **THEN** the confirmation carries danger chrome and requires the conversation's name to be typed, unlike "Remove session"

#### Scenario: The session changed under the confirmation

- **GIVEN** a delete confirmation opened for one conversation
- **WHEN** the bound thread changed before it was confirmed
- **THEN** nothing is deleted and the user is told to reopen the command

#### Scenario: Deleting is refused while a turn is streaming

- **GIVEN** a chat turn running in the open conversation
- **WHEN** "Delete session" is invoked
- **THEN** the conversation is not read, no confirmation opens, nothing is deleted, and the user is told a turn is running

#### Scenario: Removing is not refused while a turn is streaming

- **GIVEN** a chat turn running in the open conversation
- **WHEN** "Remove session" is invoked
- **THEN** the confirmation opens, because an archive leaves the turn's messages recoverable through restore
