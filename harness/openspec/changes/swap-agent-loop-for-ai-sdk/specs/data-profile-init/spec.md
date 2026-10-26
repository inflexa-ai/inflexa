## ADDED Requirements

### Requirement: The data profiler delivers its result through submit_profile

The body MUST run the `data-profiler` sandbox agent with a `submit_profile` tool. The agent's profiling result MUST arrive only through that tool. The body MUST NOT parse result JSON from the message text of the agent.

The submission MUST carry menu operations, group annotations, and dimensions with their observations. Operations MUST address top-level menu identifiers only. Declared counts MUST NOT exist, because the resolution computes each count.

#### Scenario: Membership is computed, not declared

- **WHEN** the agent submits a `use` of a detected set
- **THEN** the resolution computes the membership and the count of the group
- **AND** the submission schema carries no count field

### Requirement: submit_profile checks one submission and does not end the run

`submit_profile` MUST resolve one submission against the scan. A submission that resolves with no error and leaves no kept file unclaimed MUST be accepted. Otherwise the tool MUST give back the resolution errors. A repair is a full resubmit. The tool keeps no count of submissions, and it does not end the run.

#### Scenario: A failed resolution gets its errors

- **WHEN** a submission fails resolution
- **THEN** the tool gives back the errors, and the agent can submit a full replacement

### Requirement: The workflow resolves the last submission

After the run, the body MUST take the last accepted submission. With no accepted submission, it MUST resolve the last submission as final: a contested file sweeps. With no submission after the salvage request, the body MUST fail the profile and revoke the run authorization.

#### Scenario: The final sweep after the run

- **GIVEN** a run whose last submission still has an overlap
- **WHEN** the run ends
- **THEN** the body resolves that submission as final, and a contested file sweeps

#### Scenario: Agent never submits

- **WHEN** the run and its salvage request end with no submission
- **THEN** the body fails the profile with an error and revokes the run authorization

### Requirement: A wholly quarantined tree needs no agent

A tree that the scan kept nothing of MUST NOT reach the agent. The body MUST complete on the census that it already holds: zero groups, with the full quarantine accounting and its reasons.

#### Scenario: A wholly quarantined tree

- **GIVEN** staged inputs that the scan quarantines in full
- **THEN** the body completes the profile with no groups and the full quarantine accounting, and it starts no sandbox and calls no model
- **AND** `inspect_data_profile` serves its structure scope as available
