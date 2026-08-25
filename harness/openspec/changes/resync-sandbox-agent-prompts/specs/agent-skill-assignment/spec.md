# agent-skill-assignment Delta

## ADDED Requirements

### Requirement: A prompt summary matches the packs of its roster

A sandbox agent prompt MUST NOT claim an API reference that no pack of its
roster holds. If a pack names a package or a function as unavailable, the prompt MUST NOT
recommend it without the caveat of the pack. It MUST NOT put work in scope that a pack of its roster puts out of
scope. In each conflict, the pack is the ground truth.

#### Scenario: A reference claim resolves to a pack file

- **WHEN** a prompt names an API reference topic for one of its packs
- **THEN** a reference file for that topic exists in that pack

#### Scenario: An unavailable tool keeps its caveat

- **GIVEN** a pack that names a package or a function as unavailable
- **WHEN** the prompt of an agent with that pack mentions it
- **THEN** the prompt carries the caveat of the pack, or it does not mention
  the item

#### Scenario: The prompt scope follows the pack scope

- **GIVEN** a pack that puts a task out of scope
- **WHEN** the prompt of an agent with that pack describes its capabilities
- **THEN** the prompt does not present that task as in scope
