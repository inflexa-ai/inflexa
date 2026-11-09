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

`claims` MUST hold only the claims the procedure references, in match order. A referenced claim is a rule of a step, a flag, an alternative, or a disputed rule. The full view of a claim is at `GET /v1/claims/{claim}` of the service, and the tool MUST NOT fetch it. The situation MUST accept an optional `enrichment_input` field, and the answer MUST list in `dropped` the steps a flag removed and the steps that the script of the test does not run, for example the shrinkage of limma and edgeR.

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
- **THEN** the answer carries `plan_skeleton` and `claims` and no `procedure`. The differential expression skeleton step carries the alternative in `alternatives`, the forbidden method in `forbids`, and the alpha with its step and source in `grounding.settings`. Each claim id a skeleton step cites has one view in `claims`.
