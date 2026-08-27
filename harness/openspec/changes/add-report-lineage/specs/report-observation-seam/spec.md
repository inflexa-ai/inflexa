# Report Observation Seam

## ADDED Requirements

### Requirement: The report session emits observation events
The report session MUST emit one typed event for each of these actions, when the seam is bound: add a block, change a block, remove a block, move a block, set the title, run a derivation, preview the page, and record a version. Each event carries the analysis id, the thread id, and the data of its action. A block event names the block id. The set-title event targets the document, and it carries no block id.

#### Scenario: A block action emits
- **WHEN** the agent adds a block and the seam is bound
- **THEN** the seam receives one event with the action, the block id, the analysis id, and the thread id

#### Scenario: The set-title action emits
- **WHEN** the agent sets the title and the seam is bound
- **THEN** the seam receives one event that targets the document, with no block id

### Requirement: The seam is fire-and-forget
The emit MUST NOT block the action, and a seam failure MUST NOT fail the action. The harness does not read a result from the seam. When the seam is not bound, no event is emitted, and each action proceeds unchanged.

#### Scenario: A seam failure does not fail the action
- **WHEN** the bound seam throws on an emit
- **THEN** the action completes, and the failure is logged

#### Scenario: The seam is not bound
- **WHEN** the composition binds no observation seam
- **THEN** each action proceeds, and no event is emitted
