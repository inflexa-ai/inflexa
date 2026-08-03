## ADDED Requirements

### Requirement: The message delete runs ahead of the thread delete that can cascade

`purgeAnalysis` SHALL delete an analysis's `messages` rows before it deletes its `cortex_analysis_threads` rows, and SHALL reach the messages by joining through the thread rows. `cortex_analysis_threads` carries a self-reference (`parent_thread_id`) with `ON DELETE CASCADE`, so removing any thread row also removes its whole subtree — including rows the delete's own predicate never named, at any depth. A thread delete that ran first would therefore let the cascade drop a descendant whose transcript is still on disk.

Such messages are unrecoverable, not merely late. `messages` carries no foreign key to `cortex_analysis_threads`, and the join through that table is the only route from an analysis to its messages, so a row whose thread is gone belongs to no analysis and no later reclamation of any scope reaches it.

The single-statement form of the thread delete is not what prevents this. A parent-only delete under `ON DELETE CASCADE` succeeds and takes the subtree with it rather than raising a referential error, so no statement shape makes the wrong order safe. Only the ordering does.

#### Scenario: A three-generation thread structure is fully reclaimed

- **GIVEN** an analysis holding a conversation thread, a child of it, and a child of that child, each carrying messages
- **WHEN** `purgeAnalysis` completes successfully
- **THEN** no `cortex_analysis_threads` row and no `messages` row remains for any of the three

#### Scenario: A cascade cannot outrun the message delete

- **GIVEN** an analysis whose child threads would be removed by the cascade when their parent row is deleted
- **WHEN** `purgeAnalysis` runs
- **THEN** every one of those threads' messages is already deleted before any thread row is removed
