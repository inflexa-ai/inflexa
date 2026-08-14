## MODIFIED Requirements

<!-- The first paragraph and the four scenarios below are the requirement as it
     stands. The change is the second paragraph and the two scenarios at the end. -->

### Requirement: Hard delete reclaims the whole subtree

`purgeThread` SHALL remove the named thread, every descendant reachable through `parent_thread_id` at any depth, and the `messages` rows of every thread in that set, in the single transaction it already opens. The message delete SHALL cover the same depth the database cascade covers, because the cascade removes descendant rows recursively and would otherwise leave a deeper thread's messages behind with nothing naming them. A failure partway SHALL leave the whole subtree intact — no thread stripped of its transcript, and no transcript with nothing naming it.

`purgeThread` MUST give back the thread ids that it erased, as a readonly array in no promised order. The transaction walks that set already, thus the value restates nothing that the store must compute again. The array MUST carry the named thread and every descendant. A purge that removes nothing MUST give back an empty array, thus an absent thread stays a success with no member.

The store MUST give the ids alone. It holds a Postgres pool and no filesystem seam, thus it names no file and it removes none. A host that reclaims the bytes of a purged thread composes each path from these ids, with the layout helper of the workspace.

#### Scenario: Purging a parent removes its children

- **GIVEN** a conversation thread with two child threads, each carrying messages
- **WHEN** `purgeThread` runs on the conversation thread
- **THEN** no `cortex_analysis_threads` row and no `messages` row remains for any of the three

#### Scenario: Purging reaches a grandchild's messages

- **GIVEN** a thread with a child, and that child with a child of its own, each carrying messages
- **WHEN** `purgeThread` runs on the top thread
- **THEN** no `messages` row remains for any of the three threads

#### Scenario: Purging a child leaves its parent standing

- **GIVEN** a conversation thread with two child threads
- **WHEN** `purgeThread` runs on one child
- **THEN** that child and its messages are gone, and the conversation thread and the other child are unchanged

#### Scenario: A failed subtree delete leaves everything

- **GIVEN** a subtree whose delete fails partway
- **WHEN** the failure is observed
- **THEN** every thread row and every message in the subtree remains

#### Scenario: The purge names every thread that it erased

- **GIVEN** a conversation thread with two child threads
- **WHEN** `purgeThread` runs on the conversation thread
- **THEN** it gives back the three thread ids

#### Scenario: A purge of an absent thread names nothing

- **GIVEN** a thread id with no row
- **WHEN** `purgeThread` runs on it
- **THEN** the call succeeds, and it gives back an empty array
