## ADDED Requirements

### Requirement: The data-plan card carries the claim views of the plan

The `data-plan` part MUST have the optional field `claims`. It holds the view of each claim that a step of the plan cites: the id, the snapshot digest, the title, the statement, the strength, and the sources. A source MUST hold its DOI, its PubMed id, or its url, with its title and its year. The part schema MUST drop each other key of a stored view. The plan card builder MUST copy the views of the stored plan with the keys of the part schema. It MUST omit the field when the plan keeps no view. The type of a plan step of the part MUST also name its `grounding`.

#### Scenario: A stored plan with a claim view

- **GIVEN** a stored plan that keeps the view of `R-0028@d560`, with its rule, its severity, its license, and the direction of each source
- **WHEN** the plan card builder builds the card
- **THEN** the card holds the view with its id, snapshot, title, statement, strength, and sources
- **AND** the card holds no rule, no severity, no license, and no direction
- **AND** the `data-plan` part of the stored record holds the same views

#### Scenario: A stored plan with no claim view

- **WHEN** the plan card builder builds the card of a plan that keeps no view
- **THEN** the card has no `claims` key
