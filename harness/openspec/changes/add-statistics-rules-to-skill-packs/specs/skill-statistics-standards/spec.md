# skill-statistics-standards Delta

## ADDED Requirements

### Requirement: A survival cutpoint carries the corrected p-value

The immune-profiling pack MUST demand the maxstat corrected p-value for an
optimal survival cutpoint. The pack MUST NOT recommend an optimal cutpoint
without that correction. The nominal p-value of an optimized split has no
meaning, and the pack MUST say so or point to the rule.

#### Scenario: The pack survival guidance names the correction

- **WHEN** the agent reads the survival-integration guidance of
  `skills/immune-profiling/SKILL.md`
- **THEN** the guidance demands the maxstat corrected p-value for a cutpoint
- **AND** no line recommends an optimal cutpoint without the correction

### Requirement: Immune score comparisons carry multiplicity control

The immune-profiling pack MUST carry a Statistics section. The section MUST
demand Benjamini-Hochberg FDR over every score-by-condition comparison,
because one run compares 10 to 64 cell-type scores.

#### Scenario: The Statistics section demands BH FDR

- **WHEN** the agent reads `skills/immune-profiling/SKILL.md`
- **THEN** a Statistics section exists
- **AND** it demands BH FDR over every score-by-condition comparison

### Requirement: The immune agent can reach the statistical rules

The `meta.skills` of the immune-profiling agent MUST include
`statistical-modeling`. The Skills line of the immune agent prompt MUST name
the same packs as `meta.skills`.

#### Scenario: The cutpoint rule is searchable by the immune agent

- **WHEN** the immune agent searches its skills for cutpoint guidance
- **THEN** the corrected-p-value rule of the statistical-modeling pack is in
  its search surface

#### Scenario: The prompt Skills line matches the roster

- **WHEN** the immune agent prompt is compared with `meta.skills`
- **THEN** the Skills line names each pack of the roster, and no other pack

### Requirement: A prior supervised contrast counts as feature selection

The statistical-modeling pack MUST state the two-clause leakage rule. Clause
one: a feature list from a supervised contrast on the same samples is already
a selection. Clause two: the modeling step MUST then select again inside
cross-validation, from the full feature matrix. If it cannot, it MUST report
the performance estimate as optimistic.

#### Scenario: The pack states the cross-step clause

- **WHEN** the agent reads the panel-development guidance of
  `skills/statistical-modeling/SKILL.md`
- **THEN** the guidance states that an upstream gene list from the same
  samples is already a selection
- **AND** it demands a new selection inside cross-validation, or an
  "optimistic" label on the estimate

### Requirement: Bulk differential expression has a replication floor

The bulk-transcriptomics pack MUST refuse inferential differential expression
when no group has biological replication. In that case the pack MUST demand
descriptive fold changes only, with a statement of why. The decision tree and
the anti-pattern list MUST both carry the floor. The method-selection summary
of the bulk agent prompt MUST mirror it.

#### Scenario: A one-against-one design gets no p-values

- **WHEN** the agent reads the decision tree for a design with one sample in
  each group
- **THEN** the tree routes to descriptive fold changes only
- **AND** the anti-pattern list names inferential differential expression
  without replication

### Requirement: A violated Cox check names its remedy

The statistical-modeling pack MUST name the failure path of the Cox
proportional-hazards check. On a violation, stratify on the covariate at
fault, or add a time-varying term. The pack MUST demand that the hazard ratio
is then reported as time-averaged.

#### Scenario: The pack states the remedy

- **WHEN** the agent reads the survival guidance of
  `skills/statistical-modeling/SKILL.md`
- **THEN** the guidance names stratification or a time-varying term as the
  remedy
- **AND** it demands the time-averaged label on the hazard ratio
