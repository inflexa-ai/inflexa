## ADDED Requirements

### Requirement: The plan validation resolves each package against the pool

The shared plan validation MUST accept optional package sources: a pool index
and an image base. When the caller gives the sources, the validation MUST
resolve each entry that parses with `resolvePackage` of the `package-identity`
capability. Without the sources, the validation MUST NOT resolve an entry.

A pin of a pool package MUST NOT take part, because the census holds the
newest pin only. A pin of an image package MUST take part, because the image
holds one version of each base package.

Each answer that is not `pool` or `image` MUST give one issue that names the
step and the entry:

- `ambiguous` — the issue MUST name the two prefixed forms, written with
  `formatQuery`.
- `unknown` — the issue MUST state that the pool does not hold the package.
  When the ladder gives a suggestion, the issue MUST name its spelling and its
  identity key, with the words of the link pass.
- `image_version` — the issue MUST name the runtime version that the image
  holds.

The planner MUST take the sources from the census read that fills its seed,
and it MUST give them to the validation of `submit_plan`. The read MUST carry
its own scope and its own sources, thus no caller rebuilds them. The planner
MUST give no sources when the read is not a pool-scope read, or when the read
is `unavailable`. The pre-launch validation of a stored plan MUST take no
sources.

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
- **WHEN** the plan validates with the sources and a step names `seurat`
- **THEN** an issue names `Seurat` and `r:Seurat`

#### Scenario: A base package passes the submit

- **GIVEN** an image record whose `r_base` holds `stats` and whose `python_stdlib` holds `json`
- **WHEN** the planner submits a step whose packages are `["r:stats", "json"]`
- **THEN** no package issue is reported

#### Scenario: A wrong pin of a base package is refused at the submit

- **GIVEN** an image record whose `r_base` holds `stats`, and the R runtime `4.6.0`
- **WHEN** the plan validates with the sources and a step names `r:stats==3.0.0`
- **THEN** an issue names the step, the entry, and the version `4.6.0`

#### Scenario: A pool name keeps its answer beside an image name of the other track

- **GIVEN** a census whose R section holds `optparse`, and an image record whose `python_stdlib` holds `optparse`
- **WHEN** the plan validates with the sources and a step names `optparse`
- **THEN** no package issue is reported

#### Scenario: A validation without the sources does not resolve

- **GIVEN** a step whose packages include `sklearn`
- **WHEN** the plan validates with no sources
- **THEN** no package issue is reported

#### Scenario: An unreadable pool gives no sources

- **GIVEN** a pool-scope inventory whose read is `unavailable`
- **WHEN** the planner submits a step whose packages include `sklearn`
- **THEN** no package issue is reported

## MODIFIED Requirements

### Requirement: A plan's packages link before the launch

When the farm-extension seam is bound, the launch MUST link the plan's
packages before the run reserves anything. The linked set is the union of
the queries of each step, and it goes into the farm of the analysis. The
union MUST dedupe equal queries only: two entries are one request when
their spelling, their track, and their version are equal. A bare entry
and a qualified entry of one spelling are two requests. The pass MUST pass
each query to the seam as it was parsed.

A pool miss MUST refuse the launch with an error that names the missing
spellings. A `collision` outcome MUST refuse the launch with an error that
names the two claims and the two prefixed forms, written with `formatQuery`.
A claim is a store directory of the pool, or a runtime of the image. The
error MUST NOT promise two store directories. The harness MUST NOT name a
remedy command, because the remedy belongs to the embedder. The prefix is a
plan form and not a command, thus the refusal names it.

Without a bound seam, the pass MUST return at once.

#### Scenario: The link pass runs before the run

- **GIVEN** a bound seam and a plan whose packages the pool holds
- **WHEN** the launch runs
- **THEN** every named package links into the farm before the first sandbox action

#### Scenario: A pool miss refuses the launch

- **GIVEN** a plan that names a package the pool does not hold
- **WHEN** the launch runs
- **THEN** the launch refuses with the missing spellings, and no run starts

#### Scenario: No seam means no pass

- **GIVEN** no bound farm-extension seam
- **WHEN** the launch runs
- **THEN** the link pass returns at once, and the launch continues

#### Scenario: A prefixed entry reaches the seam with its track

- **GIVEN** a plan whose steps name `python:igraph` and `r:igraph`
- **WHEN** the link pass runs
- **THEN** the seam receives two queries with the spelling `igraph`, one with the track `python` and one with the track `r`

#### Scenario: Equal queries make one request

- **GIVEN** a plan whose steps name `scanpy` two times
- **WHEN** the link pass runs
- **THEN** the seam receives one query with the spelling `scanpy`

#### Scenario: A bare entry beside a qualified entry keeps its own refusal

- **GIVEN** a plan whose steps name `python:igraph` and `igraph`, against a pool that holds `igraph` in both tracks
- **WHEN** the link pass runs
- **THEN** the seam receives two queries, and the launch refuses on the bare one with `python:igraph` and `r:igraph` in the message

#### Scenario: Two spellings of one fold make two requests

- **GIVEN** a plan whose steps name `decoupler` and `decoupleR`, both bare
- **WHEN** the link pass runs
- **THEN** the seam receives two queries, `decoupler` and `decoupleR`, each with no track

#### Scenario: A collision refusal names the prefixed forms

- **GIVEN** a plan that names `igraph` bare, against a pool that holds `igraph` in both tracks
- **WHEN** the link pass runs
- **THEN** the launch refuses, and the message names the two claims, `python:igraph`, and `r:igraph`
