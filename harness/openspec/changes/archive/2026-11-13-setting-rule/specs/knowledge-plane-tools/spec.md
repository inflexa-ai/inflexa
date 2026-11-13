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

Each entry of `settings` is one parameter of a procedure step of the group. The entry MUST name the procedure step, the name, the value, and the source. When the service names the rule that gives the value of the parameter, the entry MUST also carry the claim id of that rule as `rule`.

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

### Requirement: The plan step carries an optional grounding

`AnalysisStepSchema` and `PlanStepSchema` MUST carry an optional `grounding` object with `status` (`grounded`, `ungrounded`, `flagged`), `snapshot`, `claims`, an optional `template`, an optional `settings` list, and `reason`. The object MUST also carry an optional `departures` list. Each entry of `settings` MUST carry the procedure step, the name, the value, an optional source, and an optional `rule`. The `rule` is the claim id of the rule that gives the value. A setting of a plan that the harness stored before the field has no `rule`, and the harness MUST NOT derive one. The value is a string, a number, a boolean, or a list of strings. The planner MUST copy `settings` from the skeleton step as it is. A plan without the field MUST validate as before. The briefing MUST render the field beside the task fields.

A departure states where a grounded step keeps its method and departs from a rule that it cites. Each entry of `departures` MUST carry the claim id of the rule and the reason. An entry MUST name the setting that it changes, unless it leaves out a part of the rule that no setting carries. An entry MUST carry the value of the plan, unless the plan does not apply the setting. The Grounding section of the briefing MUST render each departure with its rule, its setting, the value of the plan, and the reason.

The validation of the plan MUST refuse a departure in these conditions:

- its rule is not a claim of the grounding of the step
- its setting is not the name of a setting of the step
- it carries a value and no setting
- a second departure names the same setting.

A departure can name a rule id in place of a claim id. If exactly one claim of the step has that rule id, `submit_plan` MUST give the departure that claim id before the validation.

#### Scenario: A stored plan without grounding loads

- **GIVEN** a plan persisted before the field existed
- **WHEN** it is loaded and validated
- **THEN** validation passes

#### Scenario: A grounded step keeps its settings

- **GIVEN** a skeleton step whose grounding holds the alpha of the test with its step and source
- **WHEN** the planner submits the plan with the step copied as it is
- **THEN** the plan validates, and the stored step carries the setting with its step, name, value, and source

#### Scenario: A setting names its rule

- **GIVEN** a recommend answer whose differential expression step gives `alpha = 0.05` with the rule `R-0001@e7d0`, and whose adjustment step gives `adjust_method = BH` with no rule
- **WHEN** the planner submits the plan with no `grounding.settings` on the skeleton step
- **THEN** the stored step carries `alpha` with the rule `R-0001@e7d0`, and it carries `adjust_method` with no `rule`

#### Scenario: A grounded step reaches its agent

- **GIVEN** a step with a grounding that names a template
- **WHEN** the briefing composes
- **THEN** the seed carries the status, the template, the snapshot, the claims, and the reason

#### Scenario: A departure names a rule id

- **GIVEN** a recommend answer that holds `R-0001@e7d0`
- **WHEN** the planner submits a step that cites `R-0001@e7d0` and departs from `R-0001` for the setting `lfc_shrink`
- **THEN** the stored departure names `R-0001@e7d0`

#### Scenario: A departure from a rule that the step does not cite

- **WHEN** the planner submits a step whose departure names `R-0010@2b3c`, and the step does not cite `R-0010@2b3c`
- **THEN** `submit_plan` refuses the plan, and the issue names the claims of the step

#### Scenario: A step with a departure reaches its agent

- **GIVEN** a step with a departure from `R-0001@e7d0` that gives `min_count = 5`
- **WHEN** the briefing composes
- **THEN** the Grounding section lists the departure with `R-0001@e7d0`, `min_count`, the value 5, and the reason
