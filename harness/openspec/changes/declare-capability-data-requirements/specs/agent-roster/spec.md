## ADDED Requirements

### Requirement: The catalog carries the data requirement of a capability, and the rendering omits each id

`AgentMeta` MUST carry the data requirement of a capability in its optional `dataRequirements` field. The catalog MUST stay the one source of that declaration, as it is the one source of each capability phrase.

The rendered catalog that the planner reads MUST NOT carry a dataset id. The planner selects an agent by its capability phrase, which names the data classes. The ids reach the planner through its reference tool, and they reach the launch through the declaration.

A test MUST pin each declared id against the reference catalog. A test MUST pin each declared phrase against the `capabilities` of the same agent. Thus a renamed phrase and a renamed dataset each break the build.

#### Scenario: The rendered catalog names no dataset

- **WHEN** `formatAgentCatalog` renders the plannable catalog
- **THEN** the markdown holds each capability phrase and each input class, and it holds no dataset id

#### Scenario: A declaration with an unknown id fails the build

- **WHEN** a `dataRequirements` entry names an id that the reference catalog does not hold
- **THEN** the catalog test fails

#### Scenario: A declaration with a foreign phrase fails the build

- **WHEN** a `dataRequirements` entry names a phrase that the same agent does not advertise
- **THEN** the catalog test fails
