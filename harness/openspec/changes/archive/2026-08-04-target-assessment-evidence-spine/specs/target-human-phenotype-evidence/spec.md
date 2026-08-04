## ADDED Requirements

### Requirement: The assessment SHALL collect human phenotype and causal-disease associations

The assessment SHALL query a curated human phenotype resource for the resolved target and
collect its gene-to-phenotype and causal gene-to-disease associations. This evidence SHALL be
distinguishable from model-organism phenotype evidence and from aggregate gene-disease
association scores, because it asserts a different thing: an observed human phenotype
attributed to variation in the assessed gene.

#### Scenario: Target with curated human phenotypes

- **WHEN** the resolved target has curated human phenotype associations
- **THEN** the collector returns them, each carrying its ontology term identifier and label

#### Scenario: Target with causal disease associations

- **WHEN** the resolved target has causal gene-to-disease associations
- **THEN** the collector returns them, each carrying its disease identifier and label

#### Scenario: Human evidence only

- **WHEN** the resource carries associations derived from a model organism
- **THEN** the collector excludes them, leaving model-organism phenotypes to the collector that
  owns them

#### Scenario: Supporting publications are preserved

- **WHEN** an association cites publications
- **THEN** their identifiers are carried on the association

### Requirement: The collector SHALL degrade rather than fail the run

The collector SHALL report its outcome through the coverage envelope rather than throwing.
A target with no resolvable identifier for the resource SHALL report that the resource was
never queried; a query returning nothing SHALL be distinguishable from a query that was never
made; and a transport or contract failure SHALL be recorded on the envelope rather than
aborting the assessment.

#### Scenario: Target has no identifier the resource accepts

- **WHEN** identifier resolution produced nothing the resource can be queried by
- **THEN** the collector reports that the source was not consulted, with the reason

#### Scenario: Resource returns no associations

- **WHEN** the resource is queried and holds no associations for the target
- **THEN** the collector reports that the source was queried and returned nothing

#### Scenario: Resource is unreachable

- **WHEN** the request fails or the response does not match the expected contract
- **THEN** the collector reports the failure on its coverage envelope and the assessment
  continues

### Requirement: Phenotypes SHALL be resolved onto the canonical organ vocabulary at the boundary

The producer of human phenotype evidence SHALL resolve each phenotype onto the canonical organ
vocabulary at its own boundary, using the phenotype ontology's own structure rather than
matching prose. A phenotype that resolves to no canonical organ SHALL be discarded and counted,
never filed under a neighbouring organ.

#### Scenario: Phenotype under a known organ-system ancestor

- **WHEN** a phenotype's ontology ancestry includes a term denoting an organ system in the
  canonical vocabulary
- **THEN** the phenotype resolves to that canonical organ token

#### Scenario: Phenotype resolving to no canonical organ

- **WHEN** a phenotype's ancestry names no organ system present in the canonical vocabulary
- **THEN** it is discarded and counted, and no organ is assigned to it

#### Scenario: More specific ancestor wins

- **WHEN** a phenotype's ancestry includes both a broad organ-system term and a more specific
  one that maps to a different canonical organ
- **THEN** the more specific term decides the organ

#### Scenario: No second organ vocabulary is introduced

- **WHEN** the resolution mapping is defined
- **THEN** its target values are the canonical organ tokens, and it declares no enumeration of
  its own
