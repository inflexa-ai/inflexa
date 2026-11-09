## MODIFIED Requirements

### Requirement: The recommend answer carries the environment and a plan skeleton

When the host binds a farm lock, a package store, or a reference store, `knowledge_recommend` MUST join each step of the procedure with the environment. The environment gives the state of the package of the step, and its version. It says whether the reference store holds the collection the step names, and at which path. The tool MUST NOT fill a gap and MUST NOT name a path it did not read.

The state of a package MUST be one of these values:

- `installed`: the farm lock or the image record names the package, thus the sandbox loads it now.
- `in_store`: the pool-scope inventory of the package store holds the package, and no record of the sandbox names it. The launch links it into the farm when the step names it in `packages`.
- `absent`: the sandbox and the package store both do not hold the package.

The pool lookup MUST resolve a name the same way as `list_available_packages`, in the track that the service names. When the store holds the name in both tracks, the package MUST carry `entry`, the `packages` entry with its track. A bare name that both tracks hold MUST get no state.

When the host binds no pool inventory, or the inventory cannot answer, a package that no record of the sandbox names MUST get no state. The farm of an analysis links only the packages of its launched plans, thus the farm alone cannot show that a package is absent. With no path of the image record, the join MUST read the record at the container mountpoint of the store, as `list_available_packages` does. `environment_source` MUST name the source of each fact: the farm lock, the image record, the pool inventory, and the reference store.

The tool MUST give the planner one representation: `plan_skeleton` and `claims`. The model-facing answer MUST NOT carry the `procedure` of the service. `plan_skeleton` MUST be the procedure folded into plan steps. When the procedure holds a `cohort_assembly` step, the fold MUST put it in one step before the QC step, and the QC step MUST depend on it. Each skeleton step MUST carry these fields, filled from the procedure:

- the id, the name, the track, the agent, the packages, and the dependencies
- the constraints and the caveats
- the `alternatives` of the central step, the `disputed` sides, and the `forbids` list
- the `environment` of the central step
- the grounding, with `settings` filled

Each entry of `settings` is one parameter of a procedure step of the group. The entry MUST name the procedure step, the name, the value, and the source.

`claims` MUST hold one heading for each claim that the procedure references, in match order. A referenced claim is a rule of a step, a flag, an alternative, or a disputed rule. A heading MUST carry the claim id, the title, the strength, and the severity. A heading MUST NOT carry the statement or the evidence, except that the heading of a claim with no title MUST carry the statement.

The call record of the tool MUST keep the full view of each claim, and `knowledge_claims` gives it on demand. The full view of a claim is at `GET /v1/claims/{claim}` of the service, and the tool MUST NOT fetch it. The situation MUST accept an optional `enrichment_input` field, and the answer MUST list in `dropped` the steps a flag removed and the steps that the script of the test does not run, for example the shrinkage of limma and edgeR.

#### Scenario: The farm holds the package and the store holds the collection

- **GIVEN** a farm lock that lists DESeq2 and a reference store that holds the human Hallmark collection
- **WHEN** the planner calls `knowledge_recommend` for a two-group design
- **THEN** the differential expression skeleton step reads `environment.package.state: installed` with the version, and the enrichment skeleton step reads `environment.collection.present: true` with its path

#### Scenario: The store holds a package that the farm does not link

- **GIVEN** a farm lock that does not list fgsea, and a pool inventory that holds fgsea
- **WHEN** the planner calls `knowledge_recommend` for a two-group design with enrichment
- **THEN** the enrichment skeleton step reads `environment.package.state: in_store` with the version of the pool

#### Scenario: Neither the sandbox nor the store holds a package

- **GIVEN** a farm lock, an image record, and a pool inventory that do not hold samtools
- **WHEN** a procedure step names samtools
- **THEN** the step reads `environment.package.state: absent`

#### Scenario: The store holds the name in both tracks

- **GIVEN** a pool inventory that holds the R igraph and the Python igraph
- **WHEN** a procedure step names the Python igraph
- **THEN** the step reads `environment.package.state: in_store` with the Python version and `entry: python:igraph`

#### Scenario: The store cannot answer

- **GIVEN** a farm lock that does not list fgsea, and a pool inventory that the host does not bind or that cannot answer
- **WHEN** the planner calls `knowledge_recommend`
- **THEN** the enrichment step carries no package state, and `environment_source.pool` reads unknown

#### Scenario: No store is bound

- **GIVEN** a host that binds no farm lock, no package store, and no reference store
- **WHEN** the planner calls `knowledge_recommend`
- **THEN** no skeleton step carries an environment, and `environment_source` reads unknown for each source

#### Scenario: The planner receives one representation

- **GIVEN** a two-group design whose differential expression rule names an alternative method, a forbidden method, and the alpha of the test with its source
- **WHEN** the planner calls `knowledge_recommend`
- **THEN** the answer carries `plan_skeleton` and `claims` and no `procedure`. The differential expression skeleton step carries the alternative in `alternatives`, the forbidden method in `forbids`, and the alpha with its step and source in `grounding.settings`. Each claim id a skeleton step cites has one heading in `claims`.

#### Scenario: The model reads a heading of each claim

- **GIVEN** an answer whose claims carry a title, a statement, and evidence
- **WHEN** the planner calls `knowledge_recommend`
- **THEN** each entry of `claims` in the model-facing answer carries the id, the title, the strength, and the severity, and no statement and no evidence
- **AND** the call record carries the full view of each claim

### Requirement: A plan pins one release of the service

`knowledge_recommend` and `knowledge_check` of one plan generation MUST share one pin. The first `knowledge_recommend` answer MUST set the pin to the served snapshot digest. Each later call of `knowledge_recommend` and `knowledge_check` in the same plan MUST send the pin as `expected_snapshot`. `knowledge_template` MUST send the snapshot digest of the grounding of its step as `expected_snapshot`, with the step id and the claims of the step. A 409 of the service MUST be the data variant `snapshot_mismatch`, with the expected and the served digests, and the tool MUST do no work on it. The render call of `knowledge_template` MUST run in a durable step, thus a replay of the step reads the cached answer and writes the same bytes.

#### Scenario: The service moves between two calls

- **GIVEN** a plan whose first recommend answer came from release A, and a service that now serves release B
- **WHEN** the planner calls `knowledge_check`
- **THEN** the tool answers `match: snapshot_mismatch` with the two digests, and the planner submits the draft as it is

#### Scenario: A replay renders the same bytes

- **GIVEN** a step that rendered a template and a workflow that recovers
- **WHEN** the step replays its `knowledge_template` call
- **THEN** the render answer comes from the cached step, and the script and the record hold the same bytes as the first run

### Requirement: The plan keeps the view of each cited claim

When the planner saves a plan, the host MUST keep the view of each claim that a step of the plan cites in `grounding.claims`. The host MUST take a view only from the call record of the last `knowledge_recommend` answer of the invocation. A step MUST take a view only when its snapshot digest equals the digest of that answer. The stored plan MUST carry the views in the optional `claims` field, one view for each claim id, in the order of the steps. A view MUST carry the claim id, the snapshot digest, the statement, the strength, and the evidence. A view MUST also carry the rule, the title, the severity, and the license when the answer holds them. The planner MUST NOT write the `claims` field. A plan with no cited claim MUST NOT carry the field. A stored plan without the field MUST load as before.

#### Scenario: Two steps cite one claim

- **GIVEN** a recommend answer that holds the view of `R-0001@e7d0`
- **WHEN** the planner submits two steps that cite `R-0001@e7d0`, and one step that cites no claim
- **THEN** the stored plan carries one view of `R-0001@e7d0` with the snapshot digest of the answer, its title, its statement, its evidence, and its license
- **AND** the stored plan carries no view of a claim that no step cites

#### Scenario: No step cites a claim

- **GIVEN** a recommend answer
- **WHEN** the planner submits a plan whose steps cite no claim
- **THEN** the stored plan carries no `claims` field

## ADDED Requirements

### Requirement: The host gives the full view of a claim on demand

`knowledge_claims` MUST give the full view of each requested claim from the claim shelf that the recommend tool of the same conversation fills. The fold of each recommend answer MUST keep its claim views on the shelf, on the first run and on a replay. A later view of one claim id MUST replace the earlier view. The tool MUST NOT call the service, because a claim id names the content hash of its rule.

A call MUST name from 1 to `CLAIMS_PER_CALL_MAX` claim ids. The answer MUST list in `missing` each requested id that the shelf does not hold. An embedder that gives `knowledge_recommend` to an agent MUST give the agent `knowledge_claims` over the same shelf.

#### Scenario: The planner reads a claim of the answer

- **GIVEN** a recommend answer in an earlier round of the planner that holds the claim `R-0033@1a2b`
- **WHEN** the planner calls `knowledge_claims` with `R-0033@1a2b` and `R-9999@0000`
- **THEN** the answer carries the full view of `R-0033@1a2b` with its statement and its evidence, and `missing` lists `R-9999@0000`
- **AND** the service gets no call

#### Scenario: No answer holds the claim

- **GIVEN** a conversation with no recommend answer
- **WHEN** the agent calls `knowledge_claims` with `R-0001@e7d0`
- **THEN** the answer carries no view, and `missing` lists `R-0001@e7d0`
