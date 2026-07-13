# step-interpretation-summary Specification (delta)

## ADDED Requirements

### Requirement: The interpretation summary is the handoff payload for dependent steps

Each dependent step's sandbox-agent loop SHALL receive the persisted interpretation summary of every upstream `depends_on` step as the payload of a `step-handoff` standing briefing (see the conversation-briefings spec), composed by the `sandbox-step` child workflow body before the loop runs. The summary markdown SHALL be delivered verbatim — the handoff SHALL NOT re-summarize, truncate, or restructure it — read from the upstream step's persisted `runs/{runId}/{stepId}/output/summary.md`, accompanied by the upstream step's artifact locations. The parent workflow SHALL supply the upstream step identities (`stepId` and step name) to the child; the child SHALL load the summary content itself inside a checkpointed durable step.

#### Scenario: A downstream agent is briefed with the upstream summary verbatim

- **GIVEN** step `s2` depends on step `s1`, and `s1` persisted `output/summary.md`
- **WHEN** `s2`'s child workflow prepares its agent loop
- **THEN** the loop's initial messages include a `step-handoff` briefing whose content embeds `s1`'s summary markdown unchanged, together with `s1`'s artifact paths

#### Scenario: The child reads the persisted file, not a transcript

- **WHEN** the child workflow loads an upstream's handoff payload
- **THEN** the summary text comes from the upstream's persisted `output/summary.md` inside a checkpointed durable step — not from the upstream's in-memory transcript, its DBOS step cache, or the vector index

### Requirement: A missing interpretation summary degrades the handoff to omission

When an upstream step persisted no interpretation summary — the summary pipeline is best-effort and an empty result, a summarizer failure, or a write failure yields no `summary.md` — the dependent step's handoff SHALL omit that upstream's briefing entirely. The omission SHALL be non-fatal for the dependent step, SHALL NOT produce placeholder briefing content, and SHALL NOT suppress the handoff briefings of other upstream steps that did persist summaries.

#### Scenario: Best-effort summary absence propagates as omission

- **GIVEN** upstream step `s1` completed but its summarizer returned `undefined` so no `summary.md` was written
- **WHEN** the dependent step's handoff is composed
- **THEN** no `step-handoff` briefing for `s1` is injected, no placeholder is rendered, and the dependent step still runs

#### Scenario: Sibling summaries still hand off

- **GIVEN** a dependent step whose upstreams are `s1` (no summary persisted) and `s2` (summary persisted)
- **WHEN** the handoff is composed
- **THEN** `s2`'s briefing is injected normally
