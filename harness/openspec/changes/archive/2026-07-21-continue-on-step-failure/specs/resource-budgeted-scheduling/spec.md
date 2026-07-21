# resource-budgeted-scheduling — delta

> Two adjustments now that step failures no longer halt the run: capacity is
> freed by any settlement (completion, failure, or blocker), and the `neverFits`
> guard states its halt semantics explicitly instead of pointing at the removed
> "standard fail-fast".

## MODIFIED Requirements

### Requirement: Ready steps are admitted against the budget by declared weight

`scheduleReady` SHALL remain a pure function, extended to take the budget and the in-flight steps' declared resources. A dependency-satisfied step SHALL be admitted only when `sum(inFlight.cpu) + step.cpu <= budget.cpu` AND `sum(inFlight.memoryGb) + step.memoryGb <= budget.memoryGb`, using each step's plan-declared `resources`. Each scheduling round SHALL consider candidates in stable plan order, greedily admitting every candidate that fits; a candidate that does not fit SHALL NOT block a later, smaller candidate (skip-over). Capacity SHALL be freed by any settlement of an in-flight step — completion, failure, or blocker — and the scheduler SHALL run an admission round after every settlement, not only after completions. When the workflow input carries no budget, every dependency-satisfied step SHALL be admitted (legacy fan-out).

#### Scenario: A ready step waits for capacity

- **GIVEN** a budget of `{ cpu: 4, memoryGb: 8 }` and two in-flight steps declaring `{ cpu: 2, memoryGb: 4 }` each
- **WHEN** a third step declaring `{ cpu: 2, memoryGb: 4 }` becomes dependency-satisfied
- **THEN** it is not started until an in-flight step settles and frees capacity

#### Scenario: A failure frees capacity for a held step

- **GIVEN** a full budget and a dependency-satisfied step held for capacity
- **WHEN** an in-flight step settles as `failed`
- **THEN** the next admission round admits the held step against the freed capacity

#### Scenario: A smaller later candidate skips over a blocked larger one

- **GIVEN** remaining capacity `{ cpu: 2, memoryGb: 4 }` and ready candidates in plan order: `stepA { cpu: 4, memoryGb: 8 }`, `stepB { cpu: 1, memoryGb: 2 }`
- **WHEN** the scheduler runs an admission round
- **THEN** `stepB` starts and `stepA` remains held

#### Scenario: No budget in workflow input preserves legacy behavior

- **GIVEN** a workflow input without a budget
- **WHEN** three independent steps become dependency-satisfied
- **THEN** all three child workflows start immediately

### Requirement: A step that can never fit the budget fails immediately

If a dependency-satisfied step's declared resources exceed the budget outright (it could not be admitted even against an empty budget), the scheduler SHALL mark it `failed` with an error naming the resource shortfall rather than holding it indefinitely, and SHALL halt the run: in-flight children are cancelled via `DBOS.cancelWorkflow` and no further steps are scheduled. The halt is deliberate — the stored plan is invalid against this machine, so continuing other branches is not attempted (unlike an ordinary step failure, which dooms only its dependents; see the harness-durable-runtime capability). Plan-time validation makes this unreachable for newly generated plans; the guard covers stored plans and defensive depth.

#### Scenario: An over-budget step fails with a clear reason

- **GIVEN** a budget of `{ cpu: 4, memoryGb: 8 }` and a stored plan step declaring `{ cpu: 8, memoryGb: 16 }`
- **WHEN** the step becomes dependency-satisfied
- **THEN** the step is marked `failed` with an error naming the declared resources and the budget, in-flight children are cancelled, and no further steps are scheduled
