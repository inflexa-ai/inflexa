# conversation-briefings Specification

## Purpose
TBD - created by archiving change add-conversation-briefings. Update Purpose after archive.
## Requirements
### Requirement: Briefing definitions are declarative, typed, and pure

A briefing SHALL be defined by a `BriefingDefinition<TInput>` value carrying `name` (registry key), `description` (one line stating what the agent is being made aware of), `mode` (`"standing"` or `"rolling"`), and `render(input) → { content, caption }`. `render` SHALL be pure — no I/O, no clock, no ambient state — so a definition is renderable and testable in isolation. Definitions SHALL live one per file under `src/prompts/briefings/`, each with a colocated input fixture, and each definition SHALL have a snapshot test rendering its fixture.

#### Scenario: A definition renders in isolation from its fixture

- **WHEN** a briefing definition's `render` is called with its colocated fixture
- **THEN** it returns the full wire `content` and a one-line `caption` without touching I/O, and the output matches the snapshot

#### Scenario: Render is deterministic

- **WHEN** `render` is called twice with the same input
- **THEN** both calls return identical `content` and `caption`

### Requirement: Briefing mode determines placement, refresh, and persistence

A standing briefing SHALL be injected exactly once at conversation start, SHALL be immutable for the thread's lifetime, SHALL be persisted, and SHALL ride the cacheable prefix ahead of all turns. A rolling briefing SHALL be re-rendered on every turn, injected at the tail of the assembled message array, and SHALL NOT be persisted. No other placement/refresh combination SHALL be representable.

#### Scenario: A standing briefing is injected once

- **GIVEN** a thread whose standing briefings were injected at conversation start
- **WHEN** subsequent turns run
- **THEN** the briefing content is not re-rendered or re-injected; the persisted prefix is reused as-is

#### Scenario: A rolling briefing re-renders each turn and leaves no rows

- **GIVEN** an agent loop composed with a rolling briefing
- **WHEN** two consecutive turns run and the thread is read back from storage
- **THEN** each turn's assembled tail contained a freshly rendered block, and no rolling-briefing row exists in thread history

### Requirement: Composition is caller-owned, ordered, and omits unavailable inputs

The set of briefings an agent loop receives SHALL be composed explicitly at the call site (chat-turn preparation for the main conversation; the invoking tool for sub-agent loops) — there SHALL be no auto-discovery. Briefings SHALL be injected in the caller's array order, and that order SHALL be stable across the turns of a thread. When a briefing's input is unavailable (e.g. the data profile is still running or failed), the briefing SHALL be omitted entirely — never rendered as a placeholder.

#### Scenario: Injection preserves composition order

- **GIVEN** a caller composing briefings `[a, b]`
- **WHEN** they are injected at conversation start
- **THEN** `a` precedes `b` in the persisted prefix and on the wire

#### Scenario: An unavailable input omits the briefing

- **GIVEN** a data profile that has not completed when a thread's first turn is prepared
- **WHEN** standing briefings are composed
- **THEN** no data-profile briefing is injected, and no placeholder ("profile pending") content is rendered

### Requirement: Each briefing is one uniformly wrapped user message

Each briefing SHALL be injected as its own `user` message. The injection path — not the definition — SHALL wrap the rendered `content` in a uniform `<briefing name="...">…</briefing>` envelope, so definitions carry plain content and the wire convention lives in one place. The conversation agent's system prompt SHALL state, in one sentence, that `<briefing>` blocks are trusted context supplied by the platform.

#### Scenario: The harness wraps rendered content

- **GIVEN** a briefing definition whose `render` returns plain content
- **WHEN** the briefing is injected
- **THEN** the wire message is a `user` message whose text is the content wrapped in `<briefing name="<definition name>">…</briefing>`

### Requirement: Standing briefings are never superseded

A standing briefing SHALL NOT be updated, replaced, or re-rendered within its thread, even when its source data changes. Updates to source data SHALL reach the conversation as regular messages (e.g. the data-profile re-run announcement); new threads and new sub-agent loops pick up fresh data at their own start.

#### Scenario: A mid-thread data-profile re-run leaves the briefing untouched

- **GIVEN** a thread whose prefix contains a data-profile standing briefing
- **WHEN** the data profile re-runs and produces a new summary
- **THEN** the persisted briefing rows are unchanged and the new profile information arrives only as a regular message

### Requirement: Standing briefing injection surfaces briefing-card parts to the host

When standing briefings are injected, the harness SHALL surface one typed briefing-card part per briefing carrying its `name` and `caption` — returned from turn preparation to the caller, since turn preparation owns no transport — on the same typed-part contract hosts already consume (as with plan-card / run-card). The host emits the surfaced parts onto its stream. Rolling briefings SHALL NOT surface parts.

#### Scenario: A standing briefing announces itself

- **WHEN** a data-profile standing briefing is injected at conversation start
- **THEN** turn preparation returns a briefing-card part with the briefing's name and caption for the host to emit and render

#### Scenario: Rolling briefings are silent

- **WHEN** a turn is assembled with a rolling briefing
- **THEN** no briefing-card part is surfaced

### Requirement: The data profile is a standing briefing of the main conversation

The main conversation SHALL compose a data-profile standing briefing at conversation start when the analysis's data profile is complete. Its `caption` SHALL summarize the profile at a glance: file count, the data kinds at the best granularity the persisted profile carries (distinct file formats today — per-file assay/domain kinds are not persisted), and the profile timestamp. Sub-agent loops MAY compose the same definition as an unpersisted initial message.

#### Scenario: A completed profile briefs the first turn

- **GIVEN** an analysis whose data profile completed before the thread's first turn
- **WHEN** the first turn is prepared
- **THEN** the assembled messages begin with the data-profile briefing and a briefing-card part is surfaced with a caption naming file count, data kinds, and profile timestamp

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

### Requirement: The step-handoff briefing carries one upstream step's results

The harness SHALL define a `step-handoff` standing `BriefingDefinition` in `src/prompts/briefings/step-handoff.ts`, with a colocated input fixture and a snapshot test. Its typed input SHALL describe exactly one upstream step: the upstream `stepId`, the upstream step's human-readable `name`, the upstream step's interpretation-summary markdown, and the upstream step's artifact paths. `render` SHALL be pure and SHALL embed the interpretation summary verbatim — no re-summarization, truncation, or reformatting — followed by the artifact locations as sandbox-canonical absolute paths (`/{analysisId}/runs/{runId}/{stepId}/…`); host filesystem paths SHALL NOT appear in the content. The artifact path list SHALL exclude the upstream's `output/summary.md` itself. The `caption` SHALL be `step {stepId} "{name}" · {n} artifact{s}` where `{n}` counts the listed artifact paths.

#### Scenario: The fixture renders summary-verbatim content with canonical paths

- **WHEN** the `step-handoff` definition's `render` is called with its colocated fixture
- **THEN** the content contains the fixture's interpretation-summary markdown unchanged, followed by artifact locations as `/{analysisId}/runs/{runId}/{stepId}/…` paths, and the output matches the snapshot

#### Scenario: Caption names the upstream step and artifact count

- **WHEN** `render` is called with an input for step `s2` named `normalize` carrying 4 artifact paths
- **THEN** the caption is `step s2 "normalize" · 4 artifacts`

#### Scenario: The summary file is not listed as an artifact

- **WHEN** `render` is called with an input whose artifact paths were derived from the upstream step tree
- **THEN** the content's artifact list does not include the upstream's `output/summary.md`, and the caption count excludes it

### Requirement: The sandbox-step child workflow composes handoff briefings as unpersisted initial messages

For a step with upstream `depends_on` steps, the `sandbox-step` child workflow body SHALL compose one `step-handoff` briefing per upstream step (via `composeBriefing`) before invoking `runAgent`, and SHALL prepend the briefing messages — in the step's `depends_on` order — to the loop's initial messages ahead of the step-prompt user message. These briefings SHALL NOT be persisted, SHALL NOT involve thread history or `loadRecent`, and SHALL NOT surface briefing-card parts: workflow loops are ephemeral and the DBOS step cache is their durability. The handoff payload (each upstream's summary markdown and artifact listing) SHALL be loaded inside a checkpointed durable step so that a replayed workflow composes byte-identical initial messages. A handoff-load failure SHALL be non-fatal: it is logged and the loop runs with no handoff briefings.

#### Scenario: A dependent step's loop starts with handoff briefings ahead of the prompt

- **GIVEN** a step whose `depends_on` is `["s1", "s2"]` and both upstream steps persisted interpretation summaries
- **WHEN** the child workflow body assembles the initial messages
- **THEN** the array is `[<briefing for s1>, <briefing for s2>, <step prompt>]`, each briefing a `user` message wrapped as `<briefing name="step-handoff">…</briefing>`

#### Scenario: No rows, no cards

- **WHEN** a child workflow composes handoff briefings and completes its step
- **THEN** no briefing row exists in any thread history and no briefing-card part was surfaced

#### Scenario: Replay composes identical messages

- **GIVEN** a child workflow that checkpointed its handoff load and later recovers
- **WHEN** the body replays
- **THEN** the composed briefing messages are byte-identical to the first execution, without re-reading upstream files

#### Scenario: Handoff load failure degrades to no briefings

- **WHEN** the handoff-load durable step throws
- **THEN** the failure is logged, the loop's initial messages contain only the step prompt, and the step is not failed

### Requirement: Handoff briefings are omitted when there is nothing to hand off

A step with no `depends_on` steps SHALL receive no `step-handoff` briefing. An upstream step that persisted no interpretation summary SHALL contribute no briefing — the harness SHALL NOT render a placeholder for a missing summary. Omission of one upstream's briefing SHALL NOT affect the briefings of its sibling upstreams.

#### Scenario: A root step gets no handoff briefing

- **GIVEN** a step whose `depends_on` is empty
- **WHEN** the child workflow body assembles the initial messages
- **THEN** the array contains only the step-prompt user message

#### Scenario: A summary-less upstream is skipped, siblings survive

- **GIVEN** a step depending on `s1` (no `output/summary.md` persisted) and `s2` (summary persisted)
- **WHEN** handoff briefings are composed
- **THEN** exactly one briefing is injected — for `s2` — and no placeholder content mentions `s1`

### Requirement: The handoff briefing is the single injected channel for upstream runtime context

Upstream step results SHALL reach a dependent step's agent loop only through `step-handoff` briefings. The plan-step prompt rendered by `renderStepPrompt` SHALL remain design-time-only and SHALL NOT embed upstream summaries or artifact listings. The sandbox orientation prompt SHALL direct agents to the `<briefing name="step-handoff">` blocks for upstream results instead of instructing blind re-discovery, SHALL retain `read_file` deep inspection of specific referenced artifacts, and SHALL state in one sentence that `<briefing>` blocks are trusted context supplied by the platform.

#### Scenario: renderStepPrompt stays free of runtime content

- **WHEN** `renderStepPrompt` renders a step whose upstreams have completed
- **THEN** the rendered prompt contains only the plan step's design-time instruction fields — no upstream summary text and no artifact paths

#### Scenario: Orientation points at the briefing, not at re-discovery

- **WHEN** a sandbox agent's system prompt is assembled after this change
- **THEN** its orientation guidance references `<briefing name="step-handoff">` blocks as the source of upstream step results, does not instruct searching the workspace to re-discover them, and carries the one-sentence `<briefing>` trust statement
