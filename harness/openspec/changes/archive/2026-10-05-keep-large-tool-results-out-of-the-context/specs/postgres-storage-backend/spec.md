## ADDED Requirements

### Requirement: The tool output table keeps the text of a cut tool result

`initCortexState` MUST make the table `cortex_tool_outputs` with `CREATE TABLE IF NOT EXISTS`. The table MUST hold these columns:

- `analysis_id`: the analysis of the session of the loop
- `ref`: the reference that the excerpt gives
- `tool_name` and `tool_call_id`: the call that gave the result
- `thread_id`: the thread of a chat loop, nullable, and null for a loop of a run
- `content`: the kept text
- `total_length`: the length of the whole text of the result
- `created_at`: the time of the first write

The primary key MUST be `(analysis_id, ref)`. The init MUST also make a partial index on `thread_id` for the rows where it is not null, for the delete of a thread purge.

`createToolOutputStore(pool)` in `src/state/tool-outputs.ts` MUST realize the tool output store of the loop over the application pool (refer to the harness-agent-loop capability). `put` MUST be an upsert on the primary key. A second `put` of one key MUST replace the text, and it MUST keep `created_at`. `get` MUST read one row by the analysis id and the reference, and it MUST give `null` when no row exists. A failure MUST be an `err` of `DbError`, and neither method throws.

The table holds conversation data, the same as `messages`: the text of a tool result that a model can read again. A product of an analysis stays a file of the workspace tree.

#### Scenario: A kept text round-trips

- **GIVEN** a `put` of a text of 300,000 characters that holds a character outside ASCII
- **WHEN** `get` runs with the same analysis id and reference
- **THEN** it gives the same text, byte-identical, with the same length, the same tool call id, and the same thread id

#### Scenario: A second put replaces the text

- **GIVEN** a row for one analysis id and one reference
- **WHEN** a second `put` of the same key gives a different text
- **THEN** `get` gives the second text, and `created_at` does not change

#### Scenario: A reference belongs to its analysis

- **GIVEN** a row of analysis A with the reference `to_3f9a2c41b8d605e7a1c0`
- **WHEN** `get` runs with analysis B and the same reference
- **THEN** it gives `null`
