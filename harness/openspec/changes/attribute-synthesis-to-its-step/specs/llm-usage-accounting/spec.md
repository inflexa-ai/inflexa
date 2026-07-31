## ADDED Requirements

### Requirement: A phase that owns a step-execution row runs under that step's session

Every workflow phase that seeds and updates a row in the step-execution ledger SHALL run its agent loops under a `RunSession` whose `RunFrame` carries that row's step id, derived from the run session by the same value derivation sandbox steps use. A phase SHALL NOT run under the bare run session while presenting itself as a step.

Attribution is only as good as the session a phase is handed. `runAgent` faithfully copies whatever `stepId` the session carries, so a phase given the bare run frame produces records that are correct about the run and silent about the step — and silence in this ledger means "no provider reported anything", which is a different and false statement about a phase that reported plenty.

The failure is invisible by construction, which is why it is a requirement rather than a convention. Nothing fails to compile, no test fails, and no record is rejected: the rows simply lose a column, and the only symptom is a step that lists everywhere a run's steps are listed while reporting no consumption. Run-level synthesis failed exactly this way — it owned a step row, listed as a step, and recorded its synthesizer loop and every sub-agent under it against the run alone.

This SHALL hold for the phase's whole agent tree. Sub-agents derive from the phase's session, so stamping the phase covers them; a phase that re-derives from the run session for any of its children reintroduces the gap for exactly those calls.

#### Scenario: The synthesis phase's calls carry its step id

- **GIVEN** a run whose synthesis phase makes LLM calls, including calls by sub-agents it dispatches
- **WHEN** those calls are recorded
- **THEN** every record carries the synthesis step id, not the run alone

#### Scenario: A step that reports nothing is distinguishable from one that was never attributed

- **GIVEN** a run's usage grouped by step
- **WHEN** a phase owning a step row made calls that reported quantities
- **THEN** those quantities appear under that step, so an absent figure means the provider reported nothing rather than that the phase was never stamped

#### Scenario: The step segment reaches the record key

- **GIVEN** a phase running under its own step id
- **WHEN** its record keys are composed
- **THEN** they carry the step segment, so that phase and a plan step of the same run cannot mint one key from one call path
