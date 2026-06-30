# harness-working-memory Specification

## Purpose

Working memory is the harness's structured, analysis-scoped interpretive store — the durable layer that survives token-window eviction. It is one `cortex_working_memory` row per analysis: a single JSONB `data` object with four sections. `goal`, `constraints`, and `hypotheses` are analysis-flat; `findings` is run-scoped, keyed by `runId`, so a conclusion stays attributable to the run that produced it. There is deliberately no `context` section — analysis context lives in `cortex_analysis_state.context` and is injected separately at chat-route message assembly.

The store (`createWorkingMemory(pool)`) exposes three methods: `load` reads the structured shape (returning the empty shape, with no lazy insert, when no row exists), `updateSection` performs a section-addressable read-modify-write under a per-analysis advisory lock, and `render` serializes the document to Markdown. Keeping the canonical form structured and serializing to Markdown only at injection time lets an agent amend one section without resubmitting the whole document, and means the rendered text is regenerated each turn rather than persisted.

The agent maintains working memory through a single section-addressable tool, `update_working_memory`. List sections (`constraint`, `hypothesis`) accept `add`/`revise`/`retire` operations addressing an entry by the short id printed in the rendered document; `goal` is set whole; a `finding` requires the `runId` it belongs to. The rendered Markdown is injected as a `user` message in the window tail (alongside analysis context), not as a system message, so the cached system/history prefix stays byte-stable turn-to-turn.

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

The harness SHALL expose a single `update_working_memory` tool as the agent's interface for maintaining working memory. It SHALL be section-addressable: `goal` is set whole; `constraint` and `hypothesis` take `add`/`revise`/`retire` operations addressing an entry by its id; and `finding` requires a `runId`. The conversation prompt SHALL state the promotion criteria — capture user-stated binding rules to `constraints`, durable conclusions to `findings`, and keep `goal` current.

#### Scenario: A finding update requires a runId

- **WHEN** an `update_working_memory` call sets `section: "finding"` with no `runId`
- **THEN** input validation fails and the loop produces an `is_error` tool result

#### Scenario: Revising an entry requires its id

- **WHEN** an `update_working_memory` call sets `operation: "revise"` with no `id`
- **THEN** input validation fails and the loop produces an `is_error` tool result

### Requirement: Working memory renders to Markdown for tail injection

`render(analysisId)` SHALL serialize working memory to a Markdown document with all four sections, findings grouped by run, and empty sections shown explicitly as a "none yet" line. The rendered document SHALL be injected as a `user` message in the window tail each turn and SHALL NOT be persisted to thread history.

#### Scenario: Render includes every section

- **GIVEN** a working memory with a goal and one finding
- **WHEN** `render` is called
- **THEN** the output is Markdown containing all four section headings, with empty sections shown as an explicit "none yet" line

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
