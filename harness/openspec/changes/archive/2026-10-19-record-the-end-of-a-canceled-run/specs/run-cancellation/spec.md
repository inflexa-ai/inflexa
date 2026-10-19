## ADDED Requirements

### Requirement: The canceler records the end of the run that it cancels

The canceler MUST take the optional `ProvenanceSeam` of the harness. That value can bind a run emit. If the conditional terminal write changes the run row to `canceled`, the canceler MUST emit these events through that run emit, in this order:

1. One `step_completed` event with the status `canceled` for each step that the cancel cut. A cut step is a step row with a child workflow id and no `completed_at`, read after the engine cancel.
2. One `run_completed` event with the status `canceled`.

Each event MUST carry the session that the caller gave to `cancel`. The canceler MUST read the wall clock one time, after the terminal write, and each event MUST carry that time as `atMs`. The canceler is not a workflow, thus no replay fires these events again. The conditional write lets only one cancel of a run win, thus only one cancel emits them.

The `durationMs` of `run_completed` MUST be `atMs` minus the `started_at` of the run row, and not less than 0. The `durationMs` of each `step_completed` MUST be `atMs` minus the `started_at` of its step row, and not less than 0. It MUST be absent when the step row has no valid `started_at`.

When the read of the cut steps fails, the canceler MUST emit no `step_completed` event, and it MUST still emit `run_completed`.

A cancel whose terminal write changes no row MUST emit nothing, because the run ended by itself and its body recorded the end. A failed terminal write MUST emit nothing. A cancel of an already-terminal run MUST emit nothing. A throw of the run emit MUST go to the log. It MUST NOT skip a later event or a later convergence phase. It MUST NOT change the result of `cancel`. When no run emit is bound, the canceler MUST behave as it did without the seam.

#### Scenario: A won cancel records the cut steps and the run end

- **GIVEN** an active run with one cut step, and a bound run emit
- **WHEN** `cancel` runs and the terminal write changes the run row to `canceled`
- **THEN** the run emit receives `step_completed` with the status `canceled` for the cut step, and then `run_completed` with the status `canceled`
- **AND** each event carries the session of the cancel and the same `atMs`
- **AND** the `durationMs` of each event is `atMs` minus the `started_at` of its row

#### Scenario: A concurrent completion emits nothing

- **WHEN** the run changes to `completed` between the read of the canceler and its terminal write
- **THEN** the run emit receives no event

#### Scenario: A second cancel emits nothing

- **WHEN** `cancel` runs against a run whose status is `canceled`
- **THEN** the run emit receives no event

#### Scenario: A failed read of the cut steps still records the run end

- **WHEN** the read of the cut steps after the engine cancel fails, and the terminal write wins
- **THEN** the run emit receives `run_completed` with the status `canceled`, and no `step_completed` event

#### Scenario: A throwing run emit does not stop the convergence

- **WHEN** the bound run emit throws on each event
- **THEN** the canceler emits each event, logs each throw, settles the step rows, closes the charge, and revokes the mandate
- **AND** `cancel` resolves with the same result that it gives with no `ProvenanceSeam`

#### Scenario: No bound run emit changes nothing

- **WHEN** the canceler has no `ProvenanceSeam`, or one with no run emit
- **THEN** `cancel` converges the ledgers and gives the same result as before, and it emits nothing
