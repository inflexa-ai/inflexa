## ADDED Requirements

### Requirement: The DAG snapshot names each step by its plan name

`DagStepState.name` SHALL carry the plan step's human-readable name, not its identifier.
The parent workflow's input already holds the validated plan steps, each of which carries
both an id and a name, so the value requires no new threading.

A step's name is the only field in the snapshot that says what the step is *for* in
language a reader understands; its id is a slug chosen for dependency wiring. Emitting the
id under a field the contract documents as a name leaves every consumer — the durable event
stream's readers and the run-observation seam alike — rendering slugs while believing they
render names.

The `id` field SHALL continue to carry the identifier, so a consumer that needs to join
against ledger rows or dependency lists is unaffected.

#### Scenario: A snapshot step carries its plan name

- **GIVEN** a plan step whose id is a slug and whose name is a human phrase
- **WHEN** a DAG snapshot is emitted for a run of that plan
- **THEN** the step's `name` is the human phrase and its `id` is the slug

#### Scenario: Dependency wiring still uses ids

- **WHEN** a consumer resolves a step's dependencies from a snapshot
- **THEN** the dependency entries and the step `id` values match the plan's identifiers, unchanged by the name correction

### Requirement: Absent snapshot fields stay absent rather than invented

`DagStepState` fields the parent workflow does not hold SHALL be left unpopulated rather
than filled with a substitute. Specifically, the per-step artifact count and summary SHALL
remain absent: the parent has neither at snapshot time, and supplying a placeholder would
make a consumer's rendering confidently wrong rather than honestly incomplete.

#### Scenario: Unheld fields are omitted

- **WHEN** a DAG snapshot is emitted
- **THEN** per-step artifact count and summary are omitted from steps for which the workflow holds no value, rather than defaulted
