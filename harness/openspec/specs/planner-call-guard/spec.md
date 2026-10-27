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

### Requirement: The guard refuses repeated calls of the search tools

The planner MUST refuse a search call whose input the run already sent more than the identical-input limit. It MUST refuse a call past the budget of its tool, and a call past the total budget of the run. A refused call gets a refusal that tells the model to continue with the answer it has, and its tool does not run. The guard counts from the recorded calls of the run. It never refuses a terminal tool.

#### Scenario: The same input a third time

- **GIVEN** a run that called `list_available_refs` two times with the input `{ "query": "hallmark" }`
- **WHEN** the model calls it a third time with the same input
- **THEN** the call gets a refusal that names the count, the tool runs no listing, and the run continues

#### Scenario: The budget of one tool

- **GIVEN** a run that made twelve calls of `list_available_packages` with twelve different inputs
- **WHEN** the model calls it again
- **THEN** the call gets a refusal that names the budget, and the run continues

#### Scenario: A terminal tool is never refused

- **GIVEN** a run past the total budget
- **WHEN** the model calls `submit_plan`
- **THEN** the call runs

#### Scenario: A replay refuses the same calls

- **WHEN** a recovered run replays its recorded calls
- **THEN** the guard refuses the same calls as in the first run

### Requirement: Repeated refusals end the search of a plan

The planner run MUST stop after the guard refused a fixed number of calls. The salvage request then lets only the terminal tools run.

#### Scenario: A looping planner

- **GIVEN** a planner that the guard refused six times
- **WHEN** the next step is due
- **THEN** the run stops, the salvage request lets only the terminal tools run, and the plan lands before the step cap and the wall clock

### Requirement: A placeholder text gets a refusal

A terminal tool that takes a text MUST refuse a text that is a placeholder or shorter than a few characters. The clarification question of the planner and the reason of the blocker tool are such texts. The refusal names the fault, it records no outcome, and the run continues.

#### Scenario: A placeholder clarification

- **GIVEN** a planner that calls `request_clarification` with the question "Placeholder, not used"
- **WHEN** the tool runs
- **THEN** it gives a refusal, no outcome is recorded, and a later call with a real question records the clarification
