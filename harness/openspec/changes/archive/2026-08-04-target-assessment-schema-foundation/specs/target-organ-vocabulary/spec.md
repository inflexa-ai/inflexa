## ADDED Requirements

### Requirement: The system SHALL define exactly one organ-system vocabulary

There SHALL be a single canonical organ-system vocabulary shared by the safety panel, the
dossier contract, and the agent-facing prompt vocabulary. No second organ vocabulary SHALL
exist, whether as a parallel enumeration, a deprecated alias, or a free-text convention.

#### Scenario: Safety panel and dossier agree on an organ token

- **WHEN** the safety panel keys a record to an organ and the dossier records an assertion about
  the same organ
- **THEN** both use the same token, and the two join without normalization

#### Scenario: A second vocabulary is introduced

- **WHEN** a change introduces an organ enumeration separate from the canonical one
- **THEN** the change does not satisfy this specification

#### Scenario: Organ token is closed

- **WHEN** a producer supplies an organ value outside the canonical vocabulary
- **THEN** the value does not satisfy the dossier contract

### Requirement: Organ fields SHALL be typed rather than free strings

Dossier fields naming an organ or organ system SHALL be constrained to the canonical vocabulary
rather than accepting arbitrary strings. Per-organ evidence SHALL be joinable by equality on
the organ key, without string matching, case folding, or spelling reconciliation.

#### Scenario: Joining evidence across sections by organ

- **WHEN** a consumer groups assertions from different dossier sections by organ
- **THEN** equality on the organ key is sufficient to group them correctly

#### Scenario: Organ name spelling variants

- **WHEN** two sources describe the same organ using different conventional spellings
- **THEN** both resolve to one canonical token before reaching the dossier

### Requirement: Non-anatomical members SHALL be justified and documented

The canonical vocabulary SHALL be anatomical by default. A member that does not denote an organ
system SHALL be admitted only where excluding it would discard a signal that has no other
channel, and SHALL carry a recorded reason for its presence and a statement of what it costs a
per-organ grouping.

#### Scenario: Non-anatomical member is present

- **WHEN** the vocabulary contains a member that does not denote an anatomical site
- **THEN** the module records why it is retained and which producers depend on it
- **AND** records that grouping by it does not denote a site

#### Scenario: New non-anatomical member proposed

- **WHEN** a non-anatomical grouping is proposed for inclusion
- **THEN** it is admitted only if no other channel can carry its signal, and rejected otherwise

#### Scenario: Consumer groups by organ

- **WHEN** a consumer groups assertions by vocabulary member
- **THEN** it can determine from the vocabulary's own documentation which members denote
  anatomical sites

### Requirement: Agent-facing organ vocabulary SHALL be the canonical one

Prompts that instruct a model to name an organ SHALL instruct it in the canonical vocabulary.
The system SHALL NOT instruct models in one vocabulary and key its data in another, and SHALL
NOT rely on post-hoc mapping of model-emitted prose onto canonical tokens.

#### Scenario: Model instructed to report an organ

- **WHEN** a prompt directs a model to attribute a finding to an organ
- **THEN** the vocabulary it is given is the canonical one

#### Scenario: Model output reaches the dossier

- **WHEN** a model emits an organ token per its instructions
- **THEN** the token is already canonical and requires no interpretive mapping

#### Scenario: Presentation uses reader-facing labels

- **WHEN** an organ is displayed to a reader
- **THEN** a display label may be derived from the canonical token, and the canonical token
  remains the stored value

### Requirement: Producers SHALL resolve organ names at their own boundary

A producer that obtains an organ name from an external source or a model SHALL resolve it to a
canonical token at that boundary, and SHALL fail there with context when it cannot. An
unresolvable organ name SHALL NOT surface as a schema validation error at the end of an
assessment.

#### Scenario: External source uses its own organ naming

- **WHEN** an enrichment source returns organ names in its own convention
- **THEN** the producer maps them to canonical tokens as it assembles its section

#### Scenario: Organ name cannot be resolved

- **WHEN** a producer receives an organ name it cannot map to a canonical token
- **THEN** it fails at that point, identifying the unresolvable name and its source
