# knowledge-rule-records Specification (delta)

## ADDED Requirements

### Requirement: A rule record is a validated, cited JSON document

A rule record MUST validate against a Zod schema with these fields: `id`, `title`, `applies`, `effect`, `evidence`, and `version`. The `id` MUST match `INFLEXA-R-` plus six digits, and it MUST be unique in the corpus. The `effect` MUST carry a `severity` of `reject`, `warn`, or `note`, and a plain statement of the rule. No severity blocks a plan. `reject` names a rule whose violation makes a result unsound, thus its advisory ranks first and the cap never cuts it. The `evidence` block MUST hold at least one resolvable locator: a DOI, a PMID, or a URL. A DOI and a PMID MUST validate with the patterns of the citations subsystem, thus a loaded locator is one the citation resolver can resolve. A record with no resolvable locator MUST fail validation. An optional `recommendation` names the permitted alternative.

#### Scenario: A cited record validates

- **WHEN** a record carries an id, conditions, an effect with a severity, and one DOI
- **THEN** validation passes and the record loads into the corpus

#### Scenario: An uncited record fails validation

- **WHEN** a record carries no DOI, no PMID, and no URL
- **THEN** validation fails with an error that names the missing evidence

### Requirement: Applicability conditions are a closed, evaluable set

The `applies` block MUST use only the declared condition keys: the omics type, the omics subtype, and the bounded numeric predicates such as a minimum group size. A record with an unknown condition key MUST fail validation.

The keys hold data facts only. A rule whose real condition is about the plan, such as "a step optimizes a cutpoint", MUST state that condition in its own statement and MUST leave `applies` empty. Growth of the vocabulary to hold a plan condition belongs to a later change.

A categorical condition MUST match on tokens, and it MUST NOT match on an exact string. The profile writes free-form terms, thus an exact match would drop a rule on a spelling it never saw. Evaluation of a rule against the profile facts MUST return one of three outcomes: `applies`, `not_applicable`, or `not_evaluable`. A condition over a fact that the profile does not hold MUST give `not_evaluable`, never a guess.

#### Scenario: An unknown condition key is rejected

- **WHEN** a record declares a condition key outside the closed set
- **THEN** validation fails and names the key

#### Scenario: A missing fact gives an honest outcome

- **WHEN** a rule tests the group size and the profile records no group sizes
- **THEN** evaluation returns `not_evaluable` for that rule

### Requirement: The corpus is a directory with a manifest

A corpus MUST be a directory of rule files plus one manifest. The manifest MUST carry the corpus identity and the corpus version. An unknown manifest key from a newer corpus version MUST be ignored, because one added field must not turn the whole knowledge plane off. The harness MUST NOT hold the corpus path. The embedder supplies the directory, in the pattern of `skillsDir`. `describeCorpus()` MUST return the manifest identity and version.

#### Scenario: The corpus identity reaches the consumer

- **WHEN** a file-backed source loads a corpus whose manifest names version `0.1.0`
- **THEN** `describeCorpus()` returns that version, and the observation events carry it

### Requirement: The first corpus covers two skill packs with citations

The repository MUST ship a corpus converted from the `bulk-transcriptomics` and `statistical-modeling` skill packs. The conversion MUST cover the DE method decision tree, the cross-validation discipline, the cutpoint correction, the Cox proportional-hazards remedy, and the cross-step leakage rule. Each converted record MUST cite a resolvable source. A prose rule with no findable source MUST stay out of the corpus.

#### Scenario: The small-sample DE rule is a record

- **WHEN** the corpus loads
- **THEN** a `reject`-severity rule forbids inferential DE with one sample in a group, with cited sources

#### Scenario: A bulk-only rule does not claim a single-cell design

- **WHEN** the facts name a single-cell subtype with one sample for each condition
- **THEN** the bulk-only small-sample rule does not evaluate to `applies`, because its remedy is bulk-specific
