## MODIFIED Requirements

### Requirement: Hard delete reclaims the whole subtree

`purgeThread` MUST remove the named thread and each descendant that `parent_thread_id` reaches, at any depth. It MUST also remove the `messages` rows, the turn records, and the kept tool outputs of each thread in that set. It does this in the one transaction that it opens.

The deletes of the messages, of the turn records, and of the kept tool outputs MUST cover the depth that the database cascade covers. The cascade removes the descendant thread rows recursively. The messages, the turn records, and the kept tool outputs have no foreign key to a thread row. Thus a shallower delete leaves the rows of a deeper thread with nothing that names them.

The purge reaches a kept tool output by its `thread_id` (refer to the postgres-storage-backend capability). The delete MUST use the subtree walk of the other deletes, before the delete of the thread rows. A kept text of a run names no thread, thus a thread purge does not reach it.

A failure partway MUST leave the whole subtree intact. No thread loses its transcript, and no transcript loses the thread that names it.

`purgeThread` MUST give back the ids of the threads that it erased, as a readonly array in no promised order. The transaction walks that set already, thus the value restates nothing that the store must compute again. The array MUST carry the named thread and each descendant. A purge that removes nothing MUST give back an empty array, thus an absent thread stays a success with no member.

The store MUST give the ids alone. It holds a Postgres pool and no filesystem seam, thus it names no file and it removes none. A host that reclaims the bytes of a purged thread makes each path from these ids, with the layout helper of the workspace.

#### Scenario: Purging a parent removes its children

- **GIVEN** a conversation thread with two child threads, each with messages
- **WHEN** `purgeThread` runs on the conversation thread
- **THEN** no `cortex_analysis_threads` row and no `messages` row remains for any of the three

#### Scenario: Purging reaches the messages of a grandchild

- **GIVEN** a thread with a child, and that child with a child of its own, each with messages
- **WHEN** `purgeThread` runs on the top thread
- **THEN** no `messages` row remains for any of the three threads

#### Scenario: Purging removes the turn records

- **GIVEN** a conversation thread with a child thread, and each thread with a closed chat turn
- **WHEN** `purgeThread` runs on the conversation thread
- **THEN** no `cortex_thread_turns` row remains for either thread

#### Scenario: Purging removes the kept tool outputs of the subtree

- **GIVEN** a conversation thread with a child thread, and each thread with a kept text of a chat turn
- **AND** a kept text of a run of the same analysis
- **WHEN** `purgeThread` runs on the conversation thread
- **THEN** no `cortex_tool_outputs` row remains for either thread, and the kept text of the run stays

#### Scenario: Purging a child leaves its parent standing

- **GIVEN** a conversation thread with two child threads
- **WHEN** `purgeThread` runs on one child
- **THEN** that child and its messages are gone, and the conversation thread and the other child do not change

#### Scenario: A failed subtree delete leaves everything

- **GIVEN** a subtree whose delete fails partway
- **WHEN** the failure occurs
- **THEN** each thread row, each message, each turn record, and each kept tool output of the subtree remains

#### Scenario: The purge names each thread that it erased

- **GIVEN** a conversation thread with two child threads
- **WHEN** `purgeThread` runs on the conversation thread
- **THEN** it gives back the three thread ids

#### Scenario: A purge of an absent thread names nothing

- **GIVEN** a thread id with no row
- **WHEN** `purgeThread` runs on it
- **THEN** the call succeeds, and it gives back an empty array
