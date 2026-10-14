# Spec Delta

## ADDED Requirements

### Requirement: A plan approval crosses the bus and lands through the kernel

The `BusEvent` union MUST carry `prov.plan_approved`, scoped by `analysisId`. It carries the person actor and `approval: { threadId, planId, runId, approvedAtMs }`. It carries no model. The ref type MUST come from `@inflexa-ai/prov-kernel`, re-exported through `src/types/prov.ts`.

The recorder MUST map the member through `toKernelEvent` and `applyProvEvent`, the same path as each other member. The bus telemetry projection MUST surface the thread id, the plan id, and the run id.

#### Scenario: An approval lands before the start of its run

- **GIVEN** an analysis document that received `prov.run_started` for run `r1`
- **WHEN** `prov.plan_approved` for `r1` reaches the recorder with an `approvedAtMs` before the start of `r1`
- **THEN** the flushed document holds the approval action with the user agent, at a time before the start time of `r1`
