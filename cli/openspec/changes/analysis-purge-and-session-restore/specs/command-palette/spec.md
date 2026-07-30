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

### Requirement: The palette's provenance export signs before it writes

The palette's provenance export SHALL build the signature sidecar BEFORE writing the provenance document, and SHALL write neither when signing fails. Writing the document first leaves an unsigned provenance file on disk beneath a notice stating that provenance is never exported unsigned — a contradiction that the delete flow, which exports on the user's behalf without being asked, would turn from a rare inconsistency into a routine one.

#### Scenario: A signing failure writes nothing

- **GIVEN** provenance signing that fails
- **WHEN** the export runs
- **THEN** no provenance document and no sidecar are written, and the failure is reported

#### Scenario: A successful export writes both

- **WHEN** the export runs and signing succeeds
- **THEN** the provenance document and its sidecar are both written and the destination is reported
