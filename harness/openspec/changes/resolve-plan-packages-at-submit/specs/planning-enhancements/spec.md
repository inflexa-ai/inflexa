## ADDED Requirements

### Requirement: The plan validation resolves each package against the pool

The shared plan validation MUST accept an optional `PoolIndex`. When the
caller gives the index, the validation MUST resolve each entry that parses
with `resolveQuery` of the `package-identity` capability. The version of an
entry MUST NOT take part. Without the index, the validation MUST NOT resolve
an entry.

An `ambiguous` answer MUST give one issue. The issue MUST name the step and the
entry, and it MUST name the two prefixed forms, written with `formatQuery`. An
`unknown` answer MUST give one issue that names the step and the entry, and
that states that the pool does not hold the package. When the ladder gives a
suggestion, the issue MUST name its spelling and its identity key. The words
MUST be the words of the link pass.

The planner MUST build the index from the census read that fills its seed, and
it MUST give the index to the validation of `submit_plan`. The index MUST join
the tracked sections of the census and the image pool index of the record that
the census merged. The planner MUST build no index when the embedder binds no
pool-scope inventory, or when the census read is `unavailable`. The pre-launch
validation of a stored plan MUST take no index.

#### Scenario: A bare both-track name is refused at the submit

- **GIVEN** a census whose Python section and R section both hold `igraph`
- **WHEN** the planner submits a step whose packages include `igraph`
- **THEN** the submit is rejected, with an issue that names the step, `python:igraph`, and `r:igraph`

#### Scenario: A name outside the pool is refused at the submit

- **GIVEN** a census that holds `scikit-learn` and no `sklearn`
- **WHEN** the planner submits a step whose packages include `sklearn`
- **THEN** the submit is rejected, with an issue that names the step and `sklearn`

#### Scenario: A folded R spelling is refused with the suggestion

- **GIVEN** a census whose R section holds `Seurat`
- **WHEN** the plan validates with the index and a step names `seurat`
- **THEN** an issue names `Seurat` and `r:Seurat`

#### Scenario: A base package passes the submit

- **GIVEN** an image record whose `r_base` holds `stats` and whose `python_stdlib` holds `json`
- **WHEN** the planner submits a step whose packages are `["r:stats", "json"]`
- **THEN** no package issue is reported

#### Scenario: A validation without the index does not resolve

- **GIVEN** a step whose packages include `sklearn`
- **WHEN** the plan validates with no index
- **THEN** no package issue is reported

#### Scenario: An unreadable pool gives no index

- **GIVEN** a pool-scope inventory whose read is `unavailable`
- **WHEN** the planner submits a step whose packages include `scanpy`
- **THEN** no package issue is reported
