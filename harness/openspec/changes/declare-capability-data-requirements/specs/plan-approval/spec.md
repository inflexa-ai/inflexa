## ADDED Requirements

### Requirement: The launch refuses a plan whose declared reference data is absent

The pass that links the packages of a plan MUST also resolve the data requirement of each step. A step names its capability, the agent of the step holds the declaration, and the declaration names the catalog ids.

An absent dataset MUST refuse the launch with a `references_missing` reason that names each absent id. The reason MUST NOT carry a remedy command, because the remedy belongs to the embedder. A store that cannot answer MUST give that one reason, and it MUST name no dataset as absent.

The refusal MUST reach the embedder in the shape that `packages_missing` reaches it. Thus a host maps the new reason onto its own conflict, and it appends its own install command.

#### Scenario: A plan declares a capability whose dataset is absent

- **WHEN** the harness launches a stored plan, and a step declares a capability whose requirement names an absent dataset
- **THEN** the launch refuses with `references_missing`, and the reason names each absent dataset id

#### Scenario: The refusal carries no remedy

- **WHEN** a `references_missing` refusal is built
- **THEN** its message names the absent datasets, and it names no command

#### Scenario: A plan with no declared capability launches

- **WHEN** no step of the plan carries a capability phrase with a declaration
- **THEN** the pass resolves no requirement, and the launch proceeds as it does today

#### Scenario: The embedder maps the refusal

- **WHEN** the cli receives a `references_missing` refusal for a plan
- **THEN** it answers with a conflict whose reason is `references_missing` and whose body names each absent dataset id
