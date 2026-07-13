# conversation-briefings Specification (delta)

## ADDED Requirements

### Requirement: The prior-runs briefing is a lightweight index of the analysis's terminal runs

A `prior-runs` standing `BriefingDefinition` SHALL render an index of the analysis's terminal runs (completed, partial, failed, canceled), newest first, carrying per run: the run id, the run's plan title or question, the completion timestamp, and the step outcomes — completed count out of total plus the names of failed steps — in at most two rendered lines per run. In-flight (`running`, `suspended_insufficient_funds`) runs SHALL NOT appear in the index.

#### Scenario: A terminal run renders as an index entry

- **GIVEN** a completed run with 6 of 7 steps completed and one failed step `qc_step`
- **WHEN** the prior-runs briefing renders
- **THEN** the run's entry names its run id, its plan title/question, its completion timestamp, and `6/7 steps completed` with `qc_step` named as failed, within two lines

#### Scenario: In-flight runs are excluded

- **GIVEN** an analysis with one completed run and one currently running run
- **WHEN** the prior-runs briefing renders
- **THEN** the index contains only the completed run

### Requirement: The prior-runs briefing carries pointers, never result bodies

The prior-runs briefing SHALL NOT contain the run synthesis body, step summary text, or any run findings — it is awareness plus pointers only — and its content SHALL end with a fixed nudge stating that run details (step summaries, synthesis) are retrievable via the `inspect_run` tool.

#### Scenario: No result bodies in the rendered content

- **GIVEN** a completed run whose `synthesis.json` and step `summary.md` files exist
- **WHEN** the prior-runs briefing renders
- **THEN** the content contains neither synthesis text nor step-summary text — only the per-run index facets

#### Scenario: The briefing ends with the just-in-time retrieval nudge

- **WHEN** the prior-runs briefing renders with at least one run
- **THEN** the content's final line directs the agent to the `inspect_run` tool for run details

### Requirement: Run-count capping is explicit, never silent

The prior-runs briefing SHALL list at most the 10 most recent terminal runs; when more terminal runs exist, it SHALL close the index with an explicit line stating how many older runs were omitted (e.g. `…and 3 older runs`) so the model never mistakes the index for exhaustive.

#### Scenario: An over-cap history truncates visibly

- **GIVEN** an analysis with 13 terminal runs
- **WHEN** the prior-runs briefing renders
- **THEN** the 10 most recent runs are indexed and the index closes with a line stating 3 older runs exist

#### Scenario: An under-cap history carries no truncation line

- **GIVEN** an analysis with 4 terminal runs
- **WHEN** the prior-runs briefing renders
- **THEN** all 4 runs are indexed and no omitted-runs line is rendered

### Requirement: The prior-runs caption compresses the index to at-a-glance provenance

The prior-runs briefing's caption SHALL carry the terminal-run count, the latest run's id and step outcome, and the latest run's completion date — e.g. `2 prior runs · latest run_8f3a 6/7 steps · 2026-07-10`.

#### Scenario: Caption names count, latest outcome, and date

- **GIVEN** two terminal runs whose latest, `run_8f3a`, completed 6 of 7 steps on 2026-07-10
- **WHEN** the prior-runs briefing renders
- **THEN** the caption is of the form `2 prior runs · latest run_8f3a 6/7 steps · 2026-07-10`

### Requirement: The prior-runs input is read from the run ledgers by a dedicated reader

The prior-runs briefing's typed input SHALL be produced by a run-index reader over the harness's own ledgers — run rows from `cortex_runs`, step outcomes from `cortex_step_executions`, and the plan title facet from the stored plan — so that the definition's `render` stays pure over the typed input and both composition sites share one reader.

#### Scenario: Render is pure over the reader's output

- **WHEN** the run-index reader loads an analysis's terminal runs and their step outcomes
- **THEN** the prior-runs definition renders from that typed input alone, performing no I/O of its own

#### Scenario: Both composition sites use the same reader

- **WHEN** the main conversation and the planner each compose the prior-runs briefing
- **THEN** both obtain the input through the same run-index reader over the same ledgers

### Requirement: The main conversation composes prior-runs as its second standing briefing

The main conversation's turn preparation SHALL compose the prior-runs briefing at conversation start in array order `[data-profile, prior-runs]`, and SHALL omit the prior-runs briefing entirely when the analysis has no terminal runs — never rendering a "no runs yet" placeholder. Each briefing SHALL be composed independently: an unavailable data profile does not suppress prior-runs, and vice versa.

#### Scenario: Both briefings compose in order

- **GIVEN** an analysis with a completed data profile and one terminal run
- **WHEN** a thread's first turn is prepared
- **THEN** the persisted standing prefix is the data-profile briefing followed by the prior-runs briefing, and one briefing-card part per briefing is surfaced

#### Scenario: No terminal runs omits the briefing

- **GIVEN** an analysis with no terminal runs
- **WHEN** a thread's first turn is prepared
- **THEN** no prior-runs briefing is injected and no placeholder content is rendered

#### Scenario: Prior-runs composes without a data profile

- **GIVEN** an analysis whose data profile never completed but which has a terminal run
- **WHEN** a thread's first turn is prepared
- **THEN** the prior-runs briefing is injected alone

### Requirement: The prior-plan briefing serializes the plan being iterated

A `prior-plan` standing `BriefingDefinition` SHALL render the stored plan under iteration from a typed input carrying the plan id and the parsed plan: the plan id, the analytical narrative, one line per step (step id, agent, name, question, dependencies), and the iteration guidance to preserve unchanged steps and reuse step ids so downstream references survive. Its caption SHALL name the plan id and step count.

#### Scenario: A stored plan renders as the prior-plan briefing

- **GIVEN** a stored plan `pln-1a2b3c4d` with an analytical narrative and 7 steps
- **WHEN** the prior-plan briefing renders
- **THEN** the content carries the narrative, one line per step with id/agent/name/question/dependencies, and the preserve-step-IDs guidance, and the caption names `pln-1a2b3c4d` and its 7 steps

### Requirement: The planner composes shared briefing definitions as unpersisted initial messages

The `generate_plan` tool SHALL compose the same `data-profile` and `prior-runs` briefing definitions the main conversation uses — plus the `prior-plan` briefing when `parentPlanId` is set — as `<briefing>`-wrapped initial messages of the planner sub-agent loop, in array order `[data-profile, prior-runs, prior-plan]`, each omitted when its input is unavailable. These planner briefings SHALL NOT be persisted and SHALL NOT surface briefing-card parts; the research question and user constraints SHALL remain the loop's actual user message, placed after the briefing messages.

#### Scenario: Planner initial messages are briefings followed by the ask

- **GIVEN** a completed data profile, one terminal run, and a `parentPlanId`
- **WHEN** `generate_plan` starts the planner loop
- **THEN** the initial messages are the data-profile, prior-runs, and prior-plan briefing messages in that order, followed by a user message carrying the research question and user constraints

#### Scenario: Unavailable inputs are omitted for the planner too

- **GIVEN** no completed data profile and no terminal runs
- **WHEN** `generate_plan` starts the planner loop without a `parentPlanId`
- **THEN** the initial messages are exactly the user message carrying the research question and constraints — no briefing messages, no placeholders

#### Scenario: Planner briefings leave no rows and no cards

- **WHEN** `generate_plan` composes briefings for the planner loop
- **THEN** no briefing rows are written to any thread history and no briefing-card parts are surfaced

#### Scenario: The definitions are shared, not forked

- **WHEN** the planner composes the data-profile and prior-runs briefings
- **THEN** they are the same definition values the main conversation composes, producing identically wrapped content for identical inputs
