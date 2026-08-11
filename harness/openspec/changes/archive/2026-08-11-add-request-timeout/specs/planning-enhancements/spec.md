# planning-enhancements Delta

## MODIFIED Requirements

### Requirement: A single wall-clock guard bounds the whole invocation

The tool MUST bound the entire invocation with a single wall-clock guard,
merged with the caller's abort signal through `AbortSignal.any`. The guard value
MUST be the maximum of 600s (`PLAN_TIMEOUT_MS = 600_000`) and the
`requestTimeoutMs` that the planner provider advertises. There MUST be no
per-attempt timeout and no internal retry counter.

#### Scenario: Invocation times out

- **WHEN** plan generation exceeds the wall-clock guard
- **THEN** the planner is aborted and the tool returns an `error` event indicating a timeout

#### Scenario: A slow provider raises the guard

- **GIVEN** a planner provider that advertises a `requestTimeoutMs` above 600s
- **WHEN** the tool arms its wall-clock guard
- **THEN** the guard value is the advertised value, not 600s

#### Scenario: Caller abort cancels the planner

- **WHEN** the caller's abort signal fires
- **THEN** the planner is canceled and the tool returns an `error` event indicating cancellation
