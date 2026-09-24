## MODIFIED Requirements

### Requirement: submit_synthesis validates and is re-callable; no-terminal throws

`submit_synthesis` MUST validate the submitted payload again against `RunSynthesisSchema` plus the semantic checks. The checks are the `runId` match, the `stepId` references, the theme-to-finding references, the `keyReferences` that a finding cites, and numeric PMIDs. It MUST return `{ accepted: true }` on success, or `{ accepted: false, issues }` on a rejection. Thus the agent can correct the cited issue paths and call again.

When the loop ends without a terminal tool call, `runToTerminal` MUST run one salvage continuation. The salvage continuation MUST keep the declared tools of the synthesizer, and its mask MUST let only the terminal tools run. If the salvage also ends without a terminal tool call, `generateRunSynthesis` MUST throw.

A synthesis failure MUST throw again out of `synthesizeRun`, after a `failed` progress phase, thus the run fails loudly. Only two non-fatal outcomes return empty findings after a `skipped` phase: no step summaries, and a `report_blocker`.

#### Scenario: Rejected submission is fixed and resubmitted

- **WHEN** `submit_synthesis` returns `{ accepted: false, issues }`
- **THEN** the agent corrects the fields at the cited issue paths and calls `submit_synthesis` again

#### Scenario: Blocker is a non-fatal skip

- **WHEN** the synthesizer calls `report_blocker`
- **THEN** `synthesizeRun` reports a `skipped` phase with the blocker reason and returns empty findings

#### Scenario: No terminal call fails the run

- **WHEN** the loop and its salvage continuation both end without a terminal tool call
- **THEN** `generateRunSynthesis` throws, and `synthesizeRun` throws again, thus the run fails loudly

#### Scenario: The salvage keeps the tools of the synthesizer

- **GIVEN** a synthesizer run that ends without a terminal tool call
- **WHEN** the salvage continuation sends its request
- **THEN** the request declares `literature_reviewer` and the other tools of the synthesizer
- **AND** a call to `literature_reviewer` in the salvage gets the error result of the mask

## ADDED Requirements

### Requirement: The run synthesis limits the literature reviewer to three calls

`generateRunSynthesis` MUST run the synthesizer with the tool budget `{ literature_reviewer: 3 }` (refer to the harness-agent-loop capability). A fourth call of `literature_reviewer` in the run MUST get an error result that gives the limit, and the sub-agent MUST NOT run. The prompt of the synthesizer already asks for 1 to 3 delegations for each run. The budget makes that limit a rule of the harness.

#### Scenario: The fourth delegation does not run

- **GIVEN** a synthesizer that delegated 3 briefs to `literature_reviewer`
- **WHEN** it calls `literature_reviewer` a fourth time
- **THEN** the call gets an error result that gives the limit of 3, and no reviewer loop runs

#### Scenario: Three delegations in one round run

- **GIVEN** a synthesizer that calls `literature_reviewer` 3 times in one reply
- **WHEN** the loop dispatches the round
- **THEN** the 3 calls run
