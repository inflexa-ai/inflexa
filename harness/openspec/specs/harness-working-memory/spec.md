# harness-working-memory Specification

## Purpose

Working memory is the harness's structured, analysis-scoped interpretive store — the durable layer that survives token-window eviction. It is one `cortex_working_memory` row per analysis: a single JSONB `data` object with four sections. `goal`, `constraints`, and `hypotheses` are analysis-flat; `findings` is run-scoped, keyed by `runId`, so a conclusion stays attributable to the run that produced it. There is deliberately no `context` section — analysis context lives in `cortex_analysis_state.context` and is injected separately at chat-route message assembly.

The store (`createWorkingMemory(pool)`) exposes three methods: `load` reads the structured shape (returning the empty shape, with no lazy insert, when no row exists), `updateSection` performs a section-addressable read-modify-write under a per-analysis advisory lock, and `render` serializes the document to Markdown. Keeping the canonical form structured and serializing to Markdown only at injection time lets an agent amend one section without resubmitting the whole document, and means the rendered text is regenerated each turn rather than persisted.

The agent maintains working memory through a single section-addressable tool, `update_working_memory`. Every list section — `constraint`, `hypothesis`, AND `finding` — accepts `add`/`revise`/`retire` operations addressing an entry by the short id printed in the rendered document; `goal` is set whole. Adding a finding requires the `runId` it belongs to; revising or retiring one addresses it by its own id, so the agent never has to re-cite the run. The rendered Markdown is injected as a `user` message in the window tail (alongside analysis context), not as a system message, so the cached system/history prefix stays byte-stable turn-to-turn.

**Working memory is re-injected, in full, on every turn** — so every stored character is re-paid for the life of the analysis. That is what makes every section bounded at write time (`WORKING_MEMORY_LIMITS`), why an over-cap write is *rejected* rather than truncated, and why every section supports retire as well as add: memory must be able to shrink. It also fixes what memory may hold — a finding cites the `runId` that produced it and never the run's contents, which stay retrievable via `inspect_run`. There is deliberately **no** read tool: the rendered document is already in the window, so a tool to fetch it would only re-pay for what the agent can already see.

Hypothesis tracking is part of working memory, not a separate capability. The `hypotheses` section is the only home for hypotheses; the harness ships no separate hypothesis-exploration workflow or store. An agent records, refines, and prunes hypotheses conversationally — grounding them with bio-lookup tools, workspace search, and `inspectRun` — and writes each version back through `update_working_memory`. Because the section is analysis-flat, hypotheses persist across runs and conversation threads within the analysis.

## Requirements

### Requirement: Working memory is a structured, analysis-scoped store with four sections

Working memory SHALL be one `cortex_working_memory` row per analysis, holding a JSONB `data` object with four sections: `goal`, `constraints`, and `hypotheses` (analysis-flat), and `findings` (run-scoped, keyed by `runId`). It SHALL NOT carry a `context` section — analysis context lives in `cortex_analysis_state.context` and is injected separately.

#### Scenario: An empty analysis has an initial working memory shape

- **WHEN** `load` is called for an analysis with no working-memory row
- **THEN** it returns the initial shape — empty `goal`, empty `constraints`/`hypotheses`, empty `findings` — without inserting a row

#### Scenario: Findings are attributed to a run

- **GIVEN** a finding recorded under `runId` "A"
- **WHEN** working memory is loaded
- **THEN** the finding appears under the `findings` key for run "A"

### Requirement: Section updates are isolated

`updateSection(analysisId, section, value)` SHALL perform an atomic read-modify-write, under a per-analysis advisory lock, that replaces or amends only the named section and upserts the row if absent. The other three sections SHALL be left byte-identical. It SHALL NOT require the agent to resubmit the whole working-memory document.

#### Scenario: Updating one section leaves the others untouched

- **GIVEN** a populated working memory
- **WHEN** `updateSection` writes the `constraint` section
- **THEN** `goal`, `hypotheses`, and `findings` are byte-identical afterward

#### Scenario: Recording a finding for one run does not disturb another

- **GIVEN** findings exist under `runId` "A"
- **WHEN** a finding is recorded under `runId` "B"
- **THEN** the findings under "A" are unchanged

### Requirement: The agent maintains working memory through one section-addressable tool

The harness SHALL expose a single `update_working_memory` tool as the agent's interface for maintaining working memory, and SHALL expose no read tool for it (the rendered document is already injected every turn). It SHALL be section-addressable: `goal` is set whole; `constraint`, `hypothesis`, and `finding` each take `add`/`revise`/`retire` operations addressing an entry by its id. `add` on a `finding` SHALL require a `runId`; `revise`/`retire` SHALL NOT, addressing the finding by its own id instead. A `runId` that names no run of this analysis SHALL be refused with a model-correctable error — never stored as a dangling reference. The conversation prompt SHALL state the promotion criteria — capture user-stated binding rules to `constraints`, durable conclusions to `findings`, and keep `goal` current.

#### Scenario: Adding a finding requires a runId

- **WHEN** an `update_working_memory` call adds `section: "finding"` with no `runId`
- **THEN** input validation fails and the loop produces an `is_error` tool result

#### Scenario: Retiring a finding does not

- **WHEN** an `update_working_memory` call sets `section: "finding", operation: "retire", id: "<entry id>"` and no `runId`
- **THEN** the call is accepted and the finding is removed

#### Scenario: Revising an entry requires its id

- **WHEN** an `update_working_memory` call sets `operation: "revise"` with no `id`
- **THEN** input validation fails and the loop produces an `is_error` tool result

#### Scenario: An unknown runId is refused

- **WHEN** a finding is added citing a `runId` that belongs to no run of this analysis
- **THEN** the tool returns a model-visible error naming the remedy, and nothing is stored

### Requirement: Every section is bounded at write time and an over-cap write is rejected

Working memory SHALL be capped at write time by `WORKING_MEMORY_LIMITS` — a goal of 500 characters; 300 characters per constraint / hypothesis / finding entry; at most 20 constraints, 10 hypotheses, and 30 findings summed across every run. An over-cap write SHALL be **rejected**, never silently truncated, and the row SHALL be left exactly as it was. The rejection SHALL be an expected outcome carried to the model as an `is_error` tool result whose message says what to do next (shorten the text, or retire a stale entry and retry) — not a storage failure. The entry-count caps SHALL be enforced under the same per-analysis lock as the read-modify-write, so two racing adds cannot both slip past a full section.

The persisted schema SHALL remain unbounded and validate shape only: a row written before the caps existed must still `load`, so it is `render` that bounds what an oversized row is allowed to cost.

#### Scenario: An over-length entry is refused

- **WHEN** a constraint is added whose text exceeds the 300-character entry cap
- **THEN** nothing is recorded and the model receives an error telling it to shorten the text

#### Scenario: An add into a full section is refused

- **GIVEN** an analysis already holding 30 findings
- **WHEN** another finding is added
- **THEN** it is NOT recorded, and the model receives an error telling it to retire a stale entry first

#### Scenario: A legacy over-cap row still loads

- **GIVEN** a `cortex_working_memory` row written before the caps existed, holding more entries than the caps allow
- **WHEN** `load` is called
- **THEN** it returns the row rather than throwing, and `render` degrades it to its newest entries

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

#### Scenario: Findings are one flat run-referenced list

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

### Requirement: Hypotheses live in working memory, not a separate workflow

Hypotheses SHALL be persisted only as entries in the `hypotheses` section of the analysis's `cortex_working_memory` row, maintained through the same `update_working_memory` tool. The harness SHALL NOT provide a separate hypothesis-exploration workflow or store; hypothesis refinement happens in the conversation and is written back via `update_working_memory`. Because the section is analysis-flat, a hypothesis SHALL persist across runs and conversation threads within the analysis.

#### Scenario: A hypothesis is stored to working memory

- **WHEN** the agent calls `update_working_memory` with `section: "hypothesis"` and hypothesis text
- **THEN** the `hypotheses` array in the analysis's `cortex_working_memory.data` gains a new entry containing that text

#### Scenario: Refinement starts no workflow

- **WHEN** the agent refines a hypothesis using bio-lookup tools and workspace search
- **THEN** no durable workflow is started and the refined hypothesis is written back through `update_working_memory`

#### Scenario: A hypothesis survives across runs

- **GIVEN** a hypothesis recorded during one chat turn
- **WHEN** a later run completes and the agent rehydrates working memory
- **THEN** the hypothesis is rendered into the working-memory user message

### Requirement: Working memory holds the lasting facts across a compaction

A compaction of a `conversation` thread MUST let the agent move each lasting fact into working memory before the summary. The mask of the exchange lets only `update_working_memory` run. The request asks for the memory edits first, in fewer replies than the cap of the exchange. Then it asks for a summary that leaves out each fact that a memory edit accepted, and that carries each fact that the memory refused. The request tells the agent to keep each constraint that the user gave as it is.

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

### Requirement: A step seed carries a frozen read-only copy of the goal and the constraints

The seed of each sandbox step MUST carry a copy of the goal and the constraints of the working memory of its analysis. Each constraint MUST show its origin, `user` or `agent`. The copy MUST NOT hold a hypothesis, a finding, or an entry id.

The harness MUST read working memory at the dispatch of each step, inside the checkpointed step that composes the seed. It MUST NOT read it one time for each run. Thus a memory edit during a run reaches each step that the scheduler dispatches after the edit. Two steps of one run can thus carry different memory states. A replay of the seed step MUST give the recorded seed, and it MUST NOT read working memory again.

The copy is read only. The step agent gets no tool that reads or writes working memory.

The copy MUST show under the heading `## Analysis memory (read only)`. This heading is different from the heading of the constraints of the plan step. The section MUST tell the agent that the entries come from the working memory of the analysis. It MUST tell the agent to obey a constraint from the user, and to use a constraint from the agent as context.

The section MUST obey `WORKING_MEMORY_LIMITS`. It clamps the goal and each constraint text, and it shows only the newest constraints up to the cap. A memory with no goal and no constraints MUST give no section.

If the memory read fails, the seed step MUST compose the seed without the section, and it MUST log a warning that names the analysis and the step. A failed memory read MUST NOT stop the dispatch of the step.

#### Scenario: A step seed shows the goal and the constraints with their origin

- **GIVEN** an analysis whose working memory holds a goal, a constraint from the user, a constraint from the agent, a hypothesis, and a finding
- **WHEN** the parent workflow dispatches a step of that analysis
- **THEN** the seed holds the section `## Analysis memory (read only)` with the goal and the two constraints
- **AND** each constraint shows its origin
- **AND** the seed holds no hypothesis and no finding

#### Scenario: An empty memory gives no section

- **GIVEN** an analysis with no working-memory row
- **WHEN** the parent workflow dispatches a step of that analysis
- **THEN** the seed holds no analysis-memory section

#### Scenario: A later step sees an edit made during the run

- **GIVEN** a run whose first step started with the constraint `A`
- **AND** the conversation agent then replaces `A` with the constraint `B`
- **WHEN** the parent workflow dispatches a second step of the same run
- **THEN** the seed of the second step holds `B` and not `A`
- **AND** the seed of the first step stays as DBOS recorded it

#### Scenario: A replay gives the recorded seed

- **GIVEN** a seed step that DBOS recorded
- **WHEN** DBOS replays the parent workflow
- **THEN** the step gets the recorded seed, byte for byte
- **AND** the harness does not read working memory for that step

#### Scenario: A failed memory read leaves the section out

- **GIVEN** a working-memory read that gives a database error
- **WHEN** the parent workflow composes the seed of a step
- **THEN** the seed has no memory section, and the step is dispatched
- **AND** the log records a warning that names the analysis and the step
