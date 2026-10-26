# planner-call-guard Specification

## Purpose
The planner refuses calls that repeat or pass a budget, thus a planner that loops still reaches its outcome before the wall clock.

## Requirements

### Requirement: An unavailable answer does not invite a retry

The unavailable answer of the reference listing MUST state that a later call in the run gives the same answer.

#### Scenario: No store is provisioned

- **GIVEN** a host that binds no reference store
- **WHEN** the planner calls `list_available_refs`
- **THEN** the answer says that the store is not provisioned for this session and that a later call gives the same answer
