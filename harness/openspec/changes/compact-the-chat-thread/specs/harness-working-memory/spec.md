## ADDED Requirements

### Requirement: Working memory holds the lasting facts across a compaction

A compaction of a `conversation` thread MUST let the agent move each lasting fact into working memory before the summary. The mask of the exchange lets only `update_working_memory` run. The request asks for the memory edits first, and then for a summary that leaves out what working memory holds.

After the marker, the turn adds a working-memory record, because the new view holds no copy (see the chat-turn capability). The record renders the memory after the edits of the exchange. Thus the view after the marker holds the lasting facts in the record, and the summary holds the rest.

A memory edit of an exchange stays when the exchange gives no summary, because the store commits each edit when the tool runs. The records after a drop marker then hold the new render.

#### Scenario: A fact moves into memory before the summary

- **GIVEN** a `conversation` thread whose exchange adds a constraint and then replies with a summary
- **WHEN** the loop sends the next request
- **THEN** the working-memory record after the marker holds the constraint

#### Scenario: The exchange runs no other tool

- **GIVEN** an exchange whose model calls `update_working_memory` and `write_file` in one reply
- **WHEN** the loop dispatches the round
- **THEN** the memory edit runs, and `write_file` gets the error result of the mask

#### Scenario: An exchange with no summary keeps its memory edits

- **GIVEN** an exchange that adds a finding and then gives no text within its cap
- **WHEN** the loop appends the drop marker
- **THEN** working memory holds the finding, and the working-memory record after the drop marker holds it too
