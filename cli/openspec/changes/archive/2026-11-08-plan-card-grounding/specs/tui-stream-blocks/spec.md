## ADDED Requirements

### Requirement: The plan card shows the grounding of the plan

The reader of a plan card MUST copy the grounding of each step into primitive fields. It MUST join each claim id to the claim view of the card by the id and the snapshot digest. Thus a view of the same id in a different release does not match. The sources of the rules MUST dedupe by their reference, and a DOI compares in lower case. When a step has a grounding, the plan-card block MUST show one line under the plan body. The line gives the count of the grounded steps and of the flagged steps, and the knowledge release. A plan with no grounded step MUST show no line.

#### Scenario: A plan with grounded steps shows one line

- **GIVEN** a plan card of three steps, one grounded and one flagged, both at the release `sha256:71ac`
- **WHEN** the plan-card block renders
- **THEN** the block shows `grounding: 1 of 3 steps grounded · 1 flagged · knowledge release sha256:71ac`

#### Scenario: A plan with no grounding shows no line

- **WHEN** the plan-card block renders a plan whose steps have no grounding
- **THEN** the block shows no grounding line
