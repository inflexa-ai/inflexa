# Spec Delta

## ADDED Requirements

### Requirement: The sub-agents of one reply run at the same time

When one reply calls two sub-agents, the two children MUST run at the same time. A replay MUST give each call the result of its own child.

#### Scenario: Two analogy reports in one round

- **WHEN** the conversation agent calls `generate_analogy_report` two times in one reply
- **THEN** the two reasoners run at the same time, and each call gets its own report on a replay

## REMOVED Requirements

### Requirement: Two sub-agents of one reply run at the same time

**Reason**: Its only scenario names two reviewers of the synthesizer, and the reviewer goes. A MODIFIED block cannot drop a scenario, thus the requirement returns under a new name with a scenario of the analogical reasoner.

**Migration**: Refer to "The sub-agents of one reply run at the same time" in this capability. The behavior does not change.

### Requirement: The synthesis of a run starts its reviewers as children

**Reason**: The synthesizer starts no reviewer. It calls the lookups itself, and each lookup call is a step of the run workflow.

**Migration**: Refer to "The synthesis loop runs in the body of the run workflow" in the `run-synthesizer` capability.
