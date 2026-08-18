# planning-enhancements Specification

## ADDED Requirements

### Requirement: The planner names the packages of each step

The planner MUST give the packages that each step of its plan wants. A package MUST take the form of a requirement, for example `scanpy` or `polars==1.2`. The planner MUST NOT name a location, a path, or a store directory, because a store layout belongs to the embedder.

The set is what the embedder links into the farm of the analysis, before the run starts. A package that the pool holds links with no question. A package that the pool does not hold refuses the launch. The refusal names each missing package, and the reason of the embedder names the remedy. A launch of the same plan starts clean after the acquisition.

The planner MUST NOT treat the set as complete. A step reaches a package that its plan did not name through `link_packages`. Thus one package that a plan missed does not fail a whole run, and the planner needs no perfect foresight.

`validate_plan` MUST refuse a package entry that is not a requirement.

#### Scenario: A plan carries the packages of each step

- **GIVEN** a plan with two steps that use different libraries
- **WHEN** the planner returns it
- **THEN** each step carries its own package set, in requirement form

#### Scenario: A malformed package entry is refused

- **GIVEN** a plan whose package entry names a path or a URL
- **WHEN** `validate_plan` reads it
- **THEN** it refuses the plan and names the entry

#### Scenario: An incomplete set does not fail the run

- **GIVEN** a step whose plan did not name a package that its script imports
- **WHEN** the import fails inside the sandbox
- **THEN** the step links that package through `link_packages` and continues
