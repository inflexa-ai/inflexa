# Spec Delta

## ADDED Requirements

### Requirement: The prompt reads an approval record as a started run

The conversation prompt MUST state that an approval record in the thread means that the run of that plan started. The rule MUST be part of the constant prompt of the conversation agent, thus the prompt stays a function of the agent type only. The rule names no plan id, no run id, and no time.

#### Scenario: The prompt carries the approval rule

- **WHEN** the conversation agent is assembled
- **THEN** its system prompt states that an approval record means that the run of that plan started
- **AND** the system prompt is the same for each thread
