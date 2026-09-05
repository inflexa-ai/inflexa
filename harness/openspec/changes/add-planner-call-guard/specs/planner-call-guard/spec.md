## ADDED Requirements

### Requirement: A run bounds the repeated calls of one tool

The harness MUST provide a guard that wraps the tools of one run. A call whose input the run already sent more than the identical-input limit MUST answer a tool error, and a call past the per-tool budget MUST answer a tool error. The guard MUST NOT call the tool for a refused call. The error text MUST tell the model to continue with the answer it has. The counters MUST start at zero for each wrapped list.

#### Scenario: The same input a third time

- **GIVEN** a run that called `list_available_refs` twice with the input `{ "query": "hallmark" }`
- **WHEN** the model calls it a third time with the same input
- **THEN** the tool answers an error that names the count, the tool runs no listing, and the run continues

#### Scenario: The budget of one tool

- **GIVEN** a run that made twelve calls of `list_available_packages` with twelve different inputs
- **WHEN** the model calls it again
- **THEN** the tool answers an error that names the budget, and the run continues

### Requirement: The planner wraps its search tools

The planner MUST wrap its search tools with the guard on every plan generation, and MUST NOT wrap its terminal tools. The planner MUST log each refusal.

#### Scenario: A plan that never repeats a call

- **GIVEN** a planner that calls each tool at most once per input and under the budget
- **WHEN** the plan generation runs
- **THEN** every call reaches its tool, and the plan is the same as without the guard

### Requirement: Repeated refusals end the search of a plan

The agent loop MUST accept an early cap, a predicate the host gives, and MUST take the wrap-up path when it answers true at the top of an iteration. The terminal salvage MUST NOT apply the early cap to the salvage turn. The planner MUST end its search after the guard refused a fixed number of calls, and the salvage turn MUST then offer the terminal tools.

#### Scenario: A looping planner

- **GIVEN** a planner that the guard refused six times
- **WHEN** the next iteration starts
- **THEN** the loop takes the wrap-up path, the salvage turn offers `submit_plan` and `request_clarification`, and the plan lands before the iteration cap and the wall clock

### Requirement: An unavailable answer does not invite a retry

The unavailable answer of the reference listing MUST state that a later call in the run gives the same answer.

#### Scenario: No store is provisioned

- **GIVEN** a host that binds no reference store
- **WHEN** the planner calls `list_available_refs`
- **THEN** the answer says that the store is not provisioned for this session and that a later call gives the same answer
