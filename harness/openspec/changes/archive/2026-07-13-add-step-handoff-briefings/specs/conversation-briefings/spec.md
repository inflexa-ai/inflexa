# conversation-briefings Specification (delta)

## ADDED Requirements

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
