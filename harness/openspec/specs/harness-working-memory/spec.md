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

`render(analysisId)` SHALL serialize working memory to Markdown, omitting every empty section entirely — no heading, no placeholder — and SHALL return the **empty string** for an entirely empty memory, so it costs nothing. Findings SHALL render as ONE flat list, each line citing the run it came from (`- [id] (runId) text`), never as a per-run heading block: memory holds the reference, `inspect_run` holds the run. Each entry SHALL carry the short `[id]` the agent copies to revise or retire it. The render SHALL be bounded to `WORKING_MEMORY_LIMITS` regardless of what the row holds, keeping the newest entries and stating how many older ones were omitted. The rendered document SHALL be injected as a `user` message in the window tail each turn and SHALL NOT be persisted to thread history.

#### Scenario: Empty sections are omitted

- **GIVEN** a working memory with a goal and one finding, and no constraints or hypotheses
- **WHEN** `render` is called
- **THEN** the output carries a Goal heading and a Findings heading, and NO Constraints or Hypotheses heading

#### Scenario: An empty memory renders to nothing

- **WHEN** `render` is called for an analysis with no recorded working memory
- **THEN** it returns the empty string, and the outbound sanitizer drops the message before the wire call

#### Scenario: Findings are one flat run-referenced list

- **GIVEN** findings recorded under two different runs
- **WHEN** `render` is called
- **THEN** they appear as one `## Findings` list, each line naming its own run id
- **AND** the output contains no per-run heading block

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
