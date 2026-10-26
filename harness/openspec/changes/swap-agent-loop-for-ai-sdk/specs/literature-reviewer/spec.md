## ADDED Requirements

### Requirement: submit_synthesis checks a synthesis and does not end the run

`submit_synthesis` MUST check the payload against `RunSynthesisSchema` and the semantic checks: the `stepId` references, the theme-to-finding references, the `keyReferences` that a finding cites, and numeric PMIDs. It gives back the accepted synthesis or the issues. It MUST NOT end the run. The synthesizer has no separate validation tool.

#### Scenario: A refused synthesis is repaired

- **WHEN** `submit_synthesis` gives back issues
- **THEN** the synthesizer corrects the fields at the cited paths and submits again

### Requirement: The host stamps the run id of a synthesis

The model MUST NOT give the `runId` of a synthesis. The input schema of `submit_synthesis` carries no `runId`, and the host stamps the id of its run on the accepted synthesis.

#### Scenario: A synthesis carries the id of its run

- **WHEN** the synthesizer submits an accepted synthesis
- **THEN** the stored synthesis carries the `runId` of the run, and the model never typed it

### Requirement: The synthesis outcome is the last accepted submission

After the run, `generateRunSynthesis` MUST take the last accepted synthesis as the outcome. With none, a blocker gives a non-fatal skip. With neither, one salvage request follows, and only the terminal tools can run in it. When the salvage also gives no outcome, `generateRunSynthesis` MUST throw, and the run fails loudly.

#### Scenario: Blocker is a non-fatal skip

- **WHEN** the synthesizer records a blocker and no accepted synthesis
- **THEN** `synthesizeRun` reports a `skipped` phase with the reason and returns empty findings

#### Scenario: No outcome fails the run

- **WHEN** the run and its salvage both end with no outcome
- **THEN** `generateRunSynthesis` throws, and `synthesizeRun` throws again
