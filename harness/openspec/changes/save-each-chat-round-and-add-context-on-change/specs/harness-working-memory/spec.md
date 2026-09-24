## MODIFIED Requirements

### Requirement: Working memory renders only what exists

`render(analysisId)` MUST serialize the working memory to Markdown. It MUST omit each empty section completely, with no heading and no placeholder. It MUST give the empty string for a memory in which each section is empty.

The findings MUST render as one flat list, and each line names the run that it came from (`- [id] (runId) text`). The render MUST NOT give a heading block for each run. The memory holds the reference, and `inspect_run` holds the run.

Each entry MUST carry the short `[id]` that the agent copies to revise or retire it. The render MUST stay within `WORKING_MEMORY_LIMITS`, whatever the row holds. It keeps the newest entries, and it states the count of the older entries that it omitted.

A `conversation` turn MUST carry the render as a context record of the kind `working-memory`, after the user message (see the chat-turn capability). The turn stores the record only when the history window holds no copy, or when the text differs from the latest copy. An empty render gives a record that states that the memory is empty. Thus the model does not keep an older copy as the current state.

#### Scenario: Empty sections are omitted

- **GIVEN** a working memory with a goal and one finding, and no constraints or hypotheses
- **WHEN** `render` is called
- **THEN** the output carries a Goal heading and a Findings heading, and no Constraints heading and no Hypotheses heading

#### Scenario: An empty memory renders to nothing

- **WHEN** `render` is called for an analysis with no recorded working memory
- **THEN** it gives the empty string

#### Scenario: Findings are one flat list with run references

- **GIVEN** findings of two different runs
- **WHEN** `render` is called
- **THEN** they appear as one `## Findings` list, and each line names its own run id
- **AND** the output holds no heading block for each run

#### Scenario: A changed memory is stored after the user message

- **GIVEN** a conversation thread whose window holds a working-memory record, and a new constraint that the agent added after it
- **WHEN** the next turn is prepared
- **THEN** a new working-memory record with the constraint comes after the user message, and each earlier stored row does not change

#### Scenario: An emptied memory says so

- **GIVEN** a conversation thread whose window holds a working-memory record with entries, and a memory whose entries the agent retired
- **WHEN** the next turn is prepared
- **THEN** the turn adds a working-memory record that states that the memory is empty
