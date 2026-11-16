# knowledge-plane-tools Specification

## Purpose

The tools that ground a plan on the knowledge service: the optional knowledge client, the recommend, claims, and check tools of the planner, and `run_template` of a template step. The client is an interface that an embedder binds at its composition root, or does not bind. A plan pins one release of the service. A local slot never leaves the machine, and the write of each rendered script carries the facts of its render into provenance.

## Requirements

### Requirement: The knowledge client is an optional interface

The harness MUST declare a `KnowledgeClient` interface with four operations: `recommend(situation)`, `check(situation, steps)`, `render(template, slots, farm?)`, and `contract(template)`. The `contract` operation MUST read `GET /v1/templates/{id}` of the service, and it MUST answer `{ match: "rejected" }` with the field `template` on a 404. The harness MUST ship `createHttpKnowledgeClient({ baseUrl, apiKey })` as the realization over HTTPS with the retry and timeout policy of the other external tools. The harness MUST declare `TemplateSource`, the `contract` and `render` operations of the client, as the source that a template step renders from. The knowledge client is one realization of it. An embedder MUST bind a client at its composition root, or none. The harness MUST NOT read a license, a key, or an endpoint from the environment.

#### Scenario: No client is bound

- **GIVEN** a composition root that binds no knowledge client
- **WHEN** the planner tools and the sandbox agents are built
- **THEN** no knowledge tool attaches, no description of one enters the context, and every plan validates as before

#### Scenario: A client is bound

- **GIVEN** a composition root that binds a knowledge client
- **WHEN** the planner tools are built
- **THEN** the search tools of the planner hold `knowledge_recommend`, `knowledge_claims`, and `knowledge_check`

### Requirement: Every service outcome is a data variant

Each operation of the client MUST answer a typed value and MUST NOT throw on a service outcome. An unreachable service, a timeout, a 5xx, or an answer that does not match the contract MUST give `{ match: "unavailable", reason }` after the retry policy. A 400 MUST give `{ match: "rejected", message, issues }` where each issue names the field or the slot and the permitted values.

#### Scenario: The service is unreachable

- **GIVEN** a client at an endpoint that does not answer
- **WHEN** `knowledge_recommend` runs
- **THEN** the tool result is `{ match: "unavailable" }` and the loop continues

#### Scenario: A slot value is refused

- **GIVEN** a render request with a value outside the enumeration of a slot
- **WHEN** `run_template` runs
- **THEN** the tool result is `{ match: "rejected" }` with the slot and the permitted values, and no file is written

### Requirement: The check is bounded and a stated outcome satisfies a flag

`knowledge_check` MUST count its calls inside one plan generation and MUST answer `{ match: "rejected" }` without a call to the service past `CHECK_CALL_LIMIT` calls. A drafted step MUST accept an optional `outcome` field, and the service MUST NOT report a violation for a flag that removes inference when the drafted step states that outcome, in the field or in its method text.

#### Scenario: A planner rephrases a step it cannot satisfy

- **GIVEN** a plan generation that ran `CHECK_CALL_LIMIT` checks
- **WHEN** the planner calls `knowledge_check` again
- **THEN** the tool answers `{ match: "rejected" }` with a message that tells the planner to submit, and the service receives no request

#### Scenario: A descriptive step on a design without replicates

- **GIVEN** a situation with one sample in a group
- **WHEN** the planner drafts a differential expression step with `outcome: "descriptive_only"`, or with a method text that says the step is descriptive
- **THEN** the check reports no violation for that step

### Requirement: A plan after a recommend answer waits for a check

After a `knowledge_recommend` answer in one plan generation, `submit_plan` MUST refuse a plan until a `knowledge_check` of the draft ran after that answer. A later recommend answer MUST reset the state. `knowledge_check` MUST record its run in the call record of its result, thus a replay of the generation restores the state. A plan generation with no recommend answer MUST submit as before.

#### Scenario: A submit with no check refuses

- **GIVEN** a plan generation in which `knowledge_recommend` answered
- **WHEN** the planner calls `submit_plan` before any `knowledge_check`
- **THEN** the submit is refused, and the issue tells the planner to check the draft first

#### Scenario: A submit after a check passes

- **GIVEN** a plan generation in which `knowledge_check` ran after the last `knowledge_recommend` answer
- **WHEN** the planner calls `submit_plan`
- **THEN** the gate does not refuse the plan

#### Scenario: No knowledge client

- **GIVEN** an embedder that binds no knowledge client
- **WHEN** the planner calls `submit_plan`
- **THEN** the gate does not refuse the plan

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
- `kind: template` when the central step names a template

Each entry of `settings` is one parameter of a procedure step of the group. The entry MUST name the procedure step, the name, the value, and the source.

`claims` MUST hold one heading for each claim that the procedure references, in match order. A referenced claim is a rule of a step, a flag, an alternative, or a disputed rule. A heading MUST carry the claim id, the title, the strength, and the severity. A heading MUST NOT carry the statement or the evidence, except that the heading of a claim with no title MUST carry the statement.

The call record of the tool MUST keep the full view of each claim, and the `knowledge_claims` tool of the planner gives it on demand. The full view of a claim is at `GET /v1/claims/{claim}` of the service, and the tool MUST NOT fetch it. The situation MUST accept an optional `enrichment_input` field, and the answer MUST list in `dropped` the steps a flag removed and the steps that the script of the test does not run, for example the shrinkage of limma and edgeR.

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

### Requirement: A language preference selects among the templates that honor the design

The recommend tool MUST accept an optional `preferred_language` of `R` or `python`. The client MUST send it beside the situation as a preference, never as a situation field. A preference MUST NOT change a rule. The service MUST select among the templates of the method that hold and honor the design requirements of the situation. In that set, the service MUST select the first template in the preferred language.

When that template is a declared substitute, the answer MUST name the substitute as the method of the step. The step MUST carry the package and the template of the substitute, and `substitution.for` MUST name the method of record. When no template of the preferred language holds, the answer MUST keep the first template that holds. That step MUST report `limit` with the requested language and each skipped template with the requirement it lacks, or with `refused` when a slot of the template refuses a value that the rules give. The plan skeleton MUST render a substitution and a limit as a caveat of the step, never as a constraint. The caveat of a limit MUST name the refusal when one is given, because a refused value is not a fact of the design.

#### Scenario: The user asks for Python

- **GIVEN** an unpaired two-group design and a user constraint that names Python
- **WHEN** the planner calls `knowledge_recommend` with `preferred_language: python`
- **THEN** the differential expression step names the same method and the Python template of that method, with no `limit` and no `substitution`

#### Scenario: A paired design with a Python preference

- **GIVEN** a paired two-group design and a user constraint that names Python
- **WHEN** the planner calls `knowledge_recommend` with `preferred_language: python`
- **THEN** the differential expression step names the R template that honors the pairing. `limit.requested_language` reads `python`, and `limit.skipped` names the Python template and `pairing`. The skeleton step carries the limit as a caveat.

#### Scenario: The Python template is a declared substitute

- **GIVEN** an unpaired design with per-sample pathway scores and a user constraint that names Python
- **WHEN** the planner calls `knowledge_recommend` with `preferred_language: python`
- **THEN** the enrichment step names the substitute method, its package, and its template. `substitution.for` names the method of record, and the skeleton step carries the substitution as a caveat.

### Requirement: The situation is typed and carries no data

The input of `knowledge_recommend` and `knowledge_check` MUST be the flat situation schema: enumerated fields for the question, the modality, the data state, the count source, the organism, the batch structure, the library type, the strandedness, and the quality flags, plus the group and replicate counts, the pairing, the blocking factor, the covariates, the time points, and the interaction flag. The tool MUST NOT accept a sample identifier, a file path, or free text. The blocking factor, each covariate, and the continuous predictor MUST be a role from an enum, never a column name, because the situation leaves the machine.

#### Scenario: An absent optional field is omitted

- **GIVEN** a call without `covariates`
- **WHEN** the tool sends the situation
- **THEN** the request carries no `covariates` key

#### Scenario: A column name is not a role

- **GIVEN** a call with `blocking_factor: "donor_id"`
- **WHEN** the tool validates the input
- **THEN** the schema refuses the value, and the permitted roles are `individual`, `cell_line`, `litter`, `site`, `pair`, and `other`

### Requirement: A plan step is a template step or an open step

`AnalysisStepSchema` MUST carry an optional `kind` of `template` or `open`. An absent kind MUST read as `open`. The agent of a template step renders and runs the template that `grounding.template` names. The agent of an open step writes its own scripts. The validation of the plan MUST refuse a template step that names no `grounding.template`. A template on an open step MUST do nothing: the parent reads no contract for it, the briefing renders no template line, and the agent gets no `run_template`. A stored plan with no kinds MUST load, and each of its steps is open.

#### Scenario: A template step with no template

- **WHEN** the planner submits a step with `kind: template` and no `grounding.template`
- **THEN** the validation refuses the plan, and the error names the step

#### Scenario: A template on an open step

- **GIVEN** an open step whose grounding names `tpl-deseq2-two-group@1.0.0`
- **WHEN** the parent dispatches the step
- **THEN** the parent reads no contract, the seed carries no template line and no `Template contract` section, and the agent gets no `run_template`

### Requirement: run_template renders and runs the template of a template step

`run_template` MUST attach only to the agent of a template step. It MUST also attach only when the embedder binds a template source and the agent holds a mutator. The agent of an open step and a read-only agent MUST NOT get it. The tool MUST render only the template that the plan step names. It MUST send the slot values and the package versions of the farm lock and the image record. The tool MUST write the rendered script through the `WorkspaceMutator` of the step, with the tool name `run_template`. The path of the script is the path that the agent gives, relative to its working directory. With no path, the script MUST go to `<template id>.R` or `<template id>.py`, by the language of the template. The tool MUST then run the script with `Rscript` or `python3`, in the cwd that the agent gives, or in the working directory.

The result MUST carry the script path, the template with its method, the environment match, and the expected outputs of the template. It MUST also carry the exit code and the bounded streams. A run with a non-zero exit code is data, as for `execute_command`. A write that the mutator refuses MUST give the data variant `write_refused` with the path and the reason, and no run. A slot name that is not an adaptable slot of the template MUST be refused before the render. Without a binding from the host, the tool MUST read the contract to find the local and the adaptable slots. The call MUST run as one durable step. Thus a replay returns the recorded result, and it renders, writes, and runs nothing again. The exec frame of the run MUST feed the lineage collector of the step, as for `execute_command`.

The write of the script MUST carry the facts of the render into its provenance record:

- the template with its version, the label, and the method
- the snapshot digest of the release that served the render
- each setting that the script reads, with its value and its source
- each override, with its reason
- the environment match.

The service marks a slot with `read: false` when the script does not read it on this render. Such a slot MUST NOT be a setting of the record.

#### Scenario: A render and a run

- **GIVEN** a template step whose plan names `tpl-deseq2-two-group@1.0.0`, and a bound template source
- **WHEN** the agent calls `run_template` with valid slot values and no script path
- **THEN** the script lands at `tpl-deseq2-two-group.R` in the working directory, and `Rscript` runs it in that directory
- **AND** the result names the script path, the environment match, and the exit code
- **AND** the provenance record of the script names `run_template` and the facts of the render

#### Scenario: A failed run is data

- **WHEN** the script of a `run_template` call ends with exit code 1
- **THEN** the result carries `status: ran`, the exit code 1, and the bounded streams

#### Scenario: A slot that the script does not read stays out of the record

- **GIVEN** a render answer with the slot `quantifier` marked `read: false`
- **WHEN** the tool writes the script
- **THEN** the settings of the provenance record do not hold `quantifier`

#### Scenario: Only a template step gets the tool

- **GIVEN** an open step, a read-only agent, or a composition that binds no template source
- **WHEN** the tools of the agent resolve
- **THEN** `run_template` is absent

### Requirement: A template step ends after a successful run of its template

A template step MUST be done only after a `run_template` call that ended with exit code 0. A template step whose loop ends with no such run and no blocker MUST get one follow-up that asks for the run, with a bounded count of requests. When that follow-up also ends with no such run and no blocker, the step MUST end blocked with a fixed reason. A template step whose agent has no `run_template` MUST end blocked with a fixed reason, and it MUST run no loop. A blocker of the agent MUST stay the reason of a blocked step. An open step MUST end as before.

#### Scenario: A template step with a successful run

- **GIVEN** a template step whose agent called `run_template`, and the run ended with exit code 0
- **WHEN** the loop ends
- **THEN** the step takes the completed path

#### Scenario: A template step that ran no template

- **GIVEN** a template step whose loop ends with no `run_template` run that exited with code 0, and no blocker
- **WHEN** the follow-up request also ends with no such run
- **THEN** the step ends blocked, and the reason says that no run of the template exited with code 0

#### Scenario: No template source

- **GIVEN** a template step and a composition that binds no template source
- **WHEN** the step runs
- **THEN** the step runs no loop and ends blocked, and the reason says that no template source is bound

### Requirement: The step briefing carries the template contract

When a plan step is a template step and the composition binds a template source, the parent workflow MUST read the contract at dispatch. The read MUST use `contract(template)`, inside the checkpointed step that composes the seed. The child MUST NOT fetch the contract. The seed MUST carry a `Template contract` section with the adaptable slots of the contract only. For each slot the section MUST give the name, the type, the permitted values, and the pattern. It MUST give the default with its source, or the required state. The section MUST list the inputs of the template. When the contract carries notes, the section MUST render them, clamped to `TEMPLATE_NOTES_MAX_CHARS`. The section MUST NOT list a pinned slot. The section MUST render at most `MAX_TEMPLATE_SLOTS` slots, and it MUST clamp each description. The contract can be absent: no template source is bound, the service does not answer, or the service does not hold the template. Then the Grounding section MUST carry one line `Template contract: not retrieved (<reason>)`. In that case the seed MUST carry no `Template contract` section, and the template of the child input MUST carry no binding. The parent MUST NOT read a contract for an open step.

#### Scenario: A template step with a bound source

- **GIVEN** a template step whose grounding names `tpl-deseq2-two-group@1.0.0` and a composition that binds a template source
- **WHEN** the parent composes the seed of the step
- **THEN** the seed lists each adaptable slot with its type, its permitted values, and its pattern. Each slot shows its default with the source, or its required state. The seed lists the inputs and no pinned slot

#### Scenario: The contract carries notes

- **GIVEN** a served contract whose notes say that the script renames the condition column to `condition`
- **WHEN** the parent composes the seed of a template step of that template
- **THEN** the `Template contract` section carries the notes whole

#### Scenario: No source, or no answer

- **GIVEN** a template step, and a composition that binds no template source or a service that does not answer
- **WHEN** the parent composes the seed
- **THEN** the Grounding section carries `Template contract: not retrieved (<reason>)`, the seed carries no `Template contract` section, and the template of the child input carries no binding

#### Scenario: The served version differs from the plan

- **GIVEN** a template step whose grounding names version 1.0.0 of a template, and a service that serves version 1.1.0
- **WHEN** the parent composes the seed
- **THEN** the section names the served version beside the reference as a caveat, and it lists each plan setting as unbound. The template of the child input carries no binding

### Requirement: The plan settings bind to the render request

At dispatch the parent MUST bind the settings of a template step only. It MUST intersect the `grounding.settings` of the step with the adaptable slots of the served contract, by name. Each setting that names an adaptable slot MUST become a bound slot of the binding of the child input, with its source. The seed MUST list each bound setting under `Bound by the plan` with its value and its source. The seed MUST list each other setting under `Unbound settings` with its procedure step, its source when the setting has one, and the reason. A setting that names a pinned slot with a different value is a pinned conflict. A setting that names no slot stays a plan setting. A setting binds only when its value fits the slot. A fit is a member of the enum of the slot, a number for a number slot, or a boolean for a boolean slot. A free-text slot never binds, because a plan setting can be a policy word and not a value of the slot. A setting that does not fit its slot MUST be listed as unbound with the reason. `run_template` MUST merge the bound slots under the model values. The tool MUST refuse a model value that differs from a bound value when no `overrides` entry names the slot with a reason. The refusal MUST come before the service call, and it MUST name the slot, the bound value, and its source.

A departure of the plan changes a setting before the intersection. A setting that a departure names with a value MUST take the value of the departure, with the source `departure from <claim id>`. A setting that a departure names with no value MUST NOT bind. The seed MUST list that setting as unbound, with the claim id and the reason. The binding MUST carry the departures of the step.

A rule can give a setting as a policy word, which is not a value of a slot. The served contract can carry `setting_bindings`. Each entry maps one setting with one value to one slot with one slot value. The service gives no more than one entry for one setting with one value, and the parent MUST take the first such entry. The parent MUST bind the slot of an entry when a setting of the step has the name and the value of that entry. The parent MUST read the setting after its departure. Thus a departure that changes the value binds the slot only when an entry maps the new value. A departure with no value MUST NOT bind the slot, and it MUST NOT name the slot as excluded. The source of the bound slot MUST name the setting and the source of the setting. The parent MUST NOT bind the slot of an entry when the slot is not an adaptable slot of the served contract, when the slot is local, or when the slot value does not fit the slot. The seed MUST list that setting as unbound with the reason. A slot takes the first value that binds it. A later setting that gives a different value MUST be listed as unbound.

A script does some settings with no slot, for example the adjustment of a fit script. The served contract can carry `settings_by_construction`. Each entry names one setting with the value that the script does. The service gives no more than one entry for one setting, and the parent MUST take the first such entry. An entry whose setting is the name of a slot of the served contract says nothing, because the slot carries that setting. The parent MUST read the setting after its departure. A setting of the step can have the name and the value of an entry. The seed MUST then list it under `Done by the script` with its procedure step and its source. The seed MUST NOT list that setting as unbound, and the binding MUST NOT hold a slot or a source for it. When the setting has a different value, the seed MUST list it as unbound, and the line MUST name the value that the script does. A departure with no value can name the setting. The seed MUST then list it as unbound, and the line MUST say that the script does it with no slot. The binding MUST NOT name an excluded slot for it. When the served version differs from the version of the plan, the seed MUST list no setting under `Done by the script`.

A template can pin a slot at the value of a setting of the step. The script reads the pinned value, thus the setting needs no act of the agent. The seed MUST then list that setting under `Done by the script` with its procedure step and its source. The line MUST say that the template pins the slot at the same value. The seed MUST NOT list that setting as unbound.

A template gives each slot a value, and an omitted slot takes the default of the template. Thus the binding MUST name an adaptable slot as excluded when a departure with no value names it. `run_template` MUST refuse a render that sends no value for an excluded slot. It MUST also refuse a value with no override.

#### Scenario: A policy word on an integer slot

- **GIVEN** a step whose settings hold `min_samples = smallest_group_size` and `min_count = 10`
- **WHEN** the seed composes against a contract whose two slots are integers
- **THEN** the binding holds `min_count = 10` and not `min_samples`, and the seed lists `min_samples` as unbound with the reason

#### Scenario: An unbound setting keeps its source

- **GIVEN** a step whose settings hold `alpha = 0.01` with the source `doi:10.1186/s13059-014-0550-8`, and a contract that pins `alpha` at 0.05
- **WHEN** the seed composes
- **THEN** the line of `alpha` under `Unbound settings` names the procedure step and the source

#### Scenario: A setting that the template pins at the same value

- **GIVEN** a step whose settings hold `alpha = 0.05`, and a contract that pins `alpha` at 0.05
- **WHEN** the seed composes
- **THEN** the seed lists `alpha` under `Done by the script`, and the line says that the template pins it at the same value
- **AND** the seed does not list `alpha` as unbound

#### Scenario: A bound slot rides without a model value

- **GIVEN** a child input whose binding holds `lfc_shrink = apeglm` from the plan
- **WHEN** the agent calls `run_template` with the paths only
- **THEN** the render request carries `lfc_shrink = apeglm`

#### Scenario: A changed value without an override is refused

- **GIVEN** a child input whose binding holds `lfc_shrink = apeglm`
- **WHEN** the agent calls `run_template` with `lfc_shrink = ashr` and no `overrides` entry
- **THEN** the tool answers `{ match: "rejected" }` before the service call, the issue names `lfc_shrink`, the value `apeglm`, and its source, and no file is written

#### Scenario: An override with a reason renders

- **GIVEN** a child input whose binding holds `lfc_shrink = apeglm`
- **WHEN** the agent calls `run_template` with `lfc_shrink = ashr` and an `overrides` entry that names `lfc_shrink` with a reason
- **THEN** the script renders with `ashr`, and the provenance record of the script lists the override with its reason

#### Scenario: A departure changes a bound value

- **GIVEN** a step whose settings hold `min_count = 10`, and a departure from `R-0001@e7d0` that gives `min_count = 5`
- **WHEN** the seed composes against a contract whose `min_count` slot is an integer
- **THEN** the binding holds `min_count = 5` with the source `departure from R-0001@e7d0`
- **AND** the binding carries the departure

#### Scenario: A departure removes a setting

- **GIVEN** a step whose settings hold `lfc_shrink = apeglm`, and a departure from `R-0001@e7d0` for `lfc_shrink` with no value
- **WHEN** the seed composes
- **THEN** the binding holds no `lfc_shrink`, and the seed lists `lfc_shrink` as unbound with the claim id and the reason
- **AND** the binding names `lfc_shrink` as excluded

#### Scenario: A policy word that the template maps

- **GIVEN** a step whose settings hold `depth_policy = low_depth_panel` with the source `rule:R-0571`
- **AND** a served contract whose `setting_bindings` map that setting and that value to `min_count = 5`
- **WHEN** the seed composes
- **THEN** the binding holds `min_count = 5`, and its source names the setting `depth_policy` and `rule:R-0571`

#### Scenario: A departure from a mapped policy word

- **GIVEN** the same step and the same contract, and a departure that gives `depth_policy` a value that no entry maps
- **WHEN** the seed composes
- **THEN** the binding holds no `min_count`, and the seed lists `depth_policy` as unbound
- **WHEN** the departure gives `depth_policy` no value
- **THEN** the binding holds no `min_count`, and it names no excluded slot

#### Scenario: A map that the served contract does not take

- **GIVEN** a served contract whose `setting_bindings` name a slot that is local, a slot that the contract does not hold, or a value that does not fit the slot
- **WHEN** the seed composes
- **THEN** the binding holds no value for that slot, and the seed lists the setting as unbound with the reason

#### Scenario: A setting that the script does with no slot

- **GIVEN** a step whose settings hold `adjustment = BH` with the source `rule:R-0003`
- **AND** a served contract whose `settings_by_construction` hold `adjustment = BH`
- **WHEN** the seed composes
- **THEN** the seed lists `adjustment` under `Done by the script` with its procedure step and its source
- **AND** the seed does not list it as unbound, and the binding holds no slot for it

#### Scenario: A plan value that the script does not do

- **GIVEN** the same step and the same contract, and a departure that gives `adjustment = bonferroni`
- **WHEN** the seed composes
- **THEN** the seed lists `adjustment` as unbound, and the line names the value `BH` that the script does
- **WHEN** the departure gives `adjustment` no value
- **THEN** the seed lists `adjustment` as unbound, and the line says that the script does it with no slot
- **AND** the binding names no excluded slot

#### Scenario: A render of an excluded slot

- **GIVEN** a binding that names `lfc_shrink` as excluded
- **WHEN** the model renders with no `lfc_shrink`, or with `lfc_shrink` and no override
- **THEN** `run_template` refuses the render
- **WHEN** the model renders with `lfc_shrink = none` and an override with the reason
- **THEN** the render proceeds, and the provenance record of the script lists the override with its reason

### Requirement: The plan step carries an optional grounding

`AnalysisStepSchema` and `PlanStepSchema` MUST carry an optional `grounding` object with `status` (`grounded`, `ungrounded`, `flagged`), `snapshot`, `claims`, an optional `template`, an optional `settings` list, and `reason`. The object MUST also carry an optional `departures` list. Each entry of `settings` MUST carry the procedure step, the name, the value, and an optional source. The value is a string, a number, a boolean, or a list of strings. A step that keeps the id of a skeleton step takes the settings of that skeleton step from `submit_plan`. A plan without the field MUST validate as before. The briefing MUST render the field beside the task fields. The briefing MUST render the template only for a template step.

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

#### Scenario: A grounded step reaches its agent

- **GIVEN** a template step with a grounding that names a template
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

### Requirement: The planner restores the template of a skeleton step

The recommend tool MUST give each answer to the planner invocation that holds it. `submit_plan` MUST restore an absent `grounding.template` of a candidate step from the skeleton step with the same id. The restore applies only when the snapshot of the candidate step is not `none`. The restore MUST NOT change these steps:

- a step that carries a template
- a step whose status is `ungrounded`
- a step that the model made open
- a step that the skeleton does not hold.

`submit_plan` MUST stamp the snapshot digest of the answer on a skeleton step, and on a step the skeleton does not hold when one of its claims is a claim of the answer. A step with no claim of the answer keeps the digest it carries. A step whose snapshot is `none` is never stamped. The tool MUST log the ids of the restored steps and of the stamped steps.

A candidate step can keep the id of a skeleton step and give no settings. `submit_plan` MUST then write the `grounding.settings` of the skeleton step on it, unless its status is `ungrounded` or its snapshot is `none`. Settings that the model wrote MUST stay as they are. A step under another id can name the template of a skeleton step that has settings. `submit_plan` MUST refuse such a step when it gives no settings, unless its status is `ungrounded`.

`submit_plan` MUST stamp `kind: template` on a skeleton step that names a template and has no kind. A step that the model made open MUST stay open.

#### Scenario: The model drops the template

- **GIVEN** a recommend answer whose differential expression skeleton step names `tpl-deseq2-two-group@1.0.0`
- **WHEN** the planner submits that step with the claims, the snapshot, and no `template`
- **THEN** the stored step carries `grounding.template: tpl-deseq2-two-group@1.0.0` and `kind: template`

#### Scenario: A snapshot of none is left as it is

- **GIVEN** the same answer
- **WHEN** the planner submits a step with the same id and a snapshot of `none`
- **THEN** the stored step carries no template

#### Scenario: The model makes a skeleton step open

- **GIVEN** the same answer
- **WHEN** the planner submits that step with `kind: open` and no `template`
- **THEN** the stored step stays open and carries no template

#### Scenario: The host writes the settings of a skeleton step

- **GIVEN** a recommend answer whose skeleton step `T1S2` holds the alpha of the test
- **WHEN** the planner submits `T1S2` with no `grounding.settings`
- **THEN** the stored step carries the settings of the skeleton step

#### Scenario: A step outside the skeleton cites a claim of the answer

- **GIVEN** the same answer
- **WHEN** the planner submits a robustness step under an id the skeleton does not hold, with a claim of the answer and a miscopied digest
- **THEN** the stored step carries the digest of the answer, and a step with no claim of the answer keeps the digest it carried

### Requirement: A plan pins one release of the service

`knowledge_recommend` and `knowledge_check` of one plan generation MUST share one pin. The first `knowledge_recommend` answer MUST set the pin to the served snapshot digest. Each later call of `knowledge_recommend` and `knowledge_check` in the same plan MUST send the pin as `expected_snapshot`. `run_template` MUST send the snapshot digest of the grounding of its step as `expected_snapshot`, with the step id and the claims of the step. A 409 of the service MUST be the data variant `snapshot_mismatch`, with the expected and the served digests, and the tool MUST do no work on it.

#### Scenario: The service moves between two calls

- **GIVEN** a plan whose first recommend answer came from release A, and a service that now serves release B
- **WHEN** the planner calls `knowledge_check`
- **THEN** the tool answers `match: snapshot_mismatch` with the two digests, and the planner submits the draft as it is

#### Scenario: A replay runs nothing again

- **GIVEN** a step that rendered and ran a template, and a workflow that recovers
- **WHEN** the step replays its `run_template` call
- **THEN** the result comes from the recorded step, and the service gets no render call and the sandbox runs no command

### Requirement: A local slot never leaves the machine

A slot the contract marks `local` (a path, a column name, a level label, a design formula) MUST NOT be sent to the service. `run_template` MUST take the local slots from the binding of the step, or from the contract when the step has no binding. It MUST send the other slots only. A bound local slot MUST be bound on the machine, under the model value. The service answers with the marker `{{name}}` in each local slot, and the tool MUST bind the local values on the machine with the rule of the service (`bindLocalSlots`) before it writes the script. A local value the contract refuses MUST be refused by the tool, with the slot and the reason, before any write. The reason MUST end with the description of the slot, thus the agent reads the intent of a pattern beside the pattern. The briefing MUST mark each local slot.

#### Scenario: A path stays on the machine

- **GIVEN** a render call with `counts_path` and `lfc_shrink`
- **WHEN** the tool calls the service
- **THEN** the request carries `lfc_shrink` only, and the written script carries the count path in the marked line

#### Scenario: A local value the contract refuses

- **GIVEN** a render call whose `counts_path` is a number
- **WHEN** the tool binds the local slots
- **THEN** the tool answers `match: rejected` with the slot and the reason, and no file is written

#### Scenario: A formula the pattern refuses

- **GIVEN** a local `design` slot with the pattern `condition\s*$` and the description "The design formula. It must end with condition."
- **WHEN** the agent sends `~ squamous + response`
- **THEN** the issue of `design` gives the pattern and the description of the slot, and the tool calls no service

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

### Requirement: The briefing names each cited claim by its title

The run input MUST carry the claim views of the stored plan. At dispatch the parent MUST give the briefing of a step the views whose claim id and snapshot digest match the grounding of the step. The Grounding section MUST render each claim of the step with its strength and its title. When a view has no title, the section MUST render the statement. The section MUST clamp the text to `CLAIM_TITLE_MAX_CHARS`. A claim with no view MUST render as its id. When no claim of the step has a view, the section MUST render the claim ids on one line. A run input without the field MUST compose as before.

#### Scenario: A step cites a claim with a view

- **GIVEN** a plan that keeps the view of `R-0001@e7d0` at the digest of the step
- **AND** the plan keeps a view of the same id at another digest, and a view of a claim of another step
- **WHEN** the parent composes the seed of the step
- **THEN** the Grounding section renders `R-0001@e7d0` with its strength and the title of the matched view
- **AND** the seed carries neither the view of the other digest nor the view of the other step

#### Scenario: A plan with no view

- **GIVEN** a plan that keeps no claim view
- **WHEN** the parent composes the seed of a step with claims
- **THEN** the Grounding section renders the claim ids on one line

### Requirement: The methods of a step are built on read

The host MUST build the methods of a step when a reader asks for them. The inputs are the grounding of the plan step, the claim views of the stored plan, and the rows of the step in `cortex_artifacts` whose `template` column is set. The methods MUST hold these items:

- the grounding status, and the snapshot digest of the grounding, else of the first template row
- one template entry for each template row, in path order, with the method, the environment match, and the script path relative to the step directory
- the claims of the grounding, with the title and the strength of a view whose claim id and snapshot digest match
- one source for each DOI, PubMed id, or URL of the evidence of those views
- the departures of the grounding
- the license of the rule text.

The claim list, the source list, and the departure list MUST be bounded, and each MUST count its tail. The read MUST also give the full list of the sources, for the citation evidence. A step with no grounding and no template row MUST have no methods. The host MUST NOT write the methods into the summary of a step, and no chat part carries them. The handoff of an upstream step in a seed MUST carry no methods.

#### Scenario: A template step after its run

- **GIVEN** a step whose grounding cites `R-0028@d560` with a view that holds one DOI, and a template row of `tpl-edger-ql@1.8.0`
- **WHEN** a reader reads the methods of the step
- **THEN** the methods name the template, its method, the title of `R-0028@d560`, and the DOI

#### Scenario: A step with no grounding and no template row

- **WHEN** a reader reads the methods of a step with no grounding and no template row
- **THEN** the step has no methods

### Requirement: The planner reads the full view of a claim on demand

`knowledge_claims` MUST exist only among the tools of the planner. It MUST give the full view of each requested claim from the claim shelf of the planner invocation. The recommend tool of the same invocation fills the shelf. The fold of each recommend answer MUST keep its claim views on the shelf, on the first run and on a replay. A later view of one claim id MUST replace the earlier view. The tool MUST NOT call the service, because a claim id names the content hash of its rule.

A call MUST name from 1 to `CLAIMS_PER_CALL_MAX` claim ids. The answer MUST list in `missing` each requested id that the shelf does not hold. The conversation agent MUST NOT get `knowledge_claims`. An embedder can give the conversation agent `knowledge_recommend`, and that tool then fills no shelf.

#### Scenario: The planner reads a claim of the answer

- **GIVEN** a recommend answer in an earlier round of the planner that holds the claim `R-0033@1a2b`
- **WHEN** the planner calls `knowledge_claims` with `R-0033@1a2b` and `R-9999@0000`
- **THEN** the answer carries the full view of `R-0033@1a2b` with its statement and its evidence, and `missing` lists `R-9999@0000`
- **AND** the service gets no call

#### Scenario: No answer holds the claim

- **GIVEN** a planner invocation with no recommend answer
- **WHEN** the planner calls `knowledge_claims` with `R-0001@e7d0`
- **THEN** the answer carries no view, and `missing` lists `R-0001@e7d0`

#### Scenario: The conversation agent gets no claims tool

- **GIVEN** an embedder that binds a knowledge client and gives the conversation agent `knowledge_recommend`
- **WHEN** the tools of the conversation agent resolve
- **THEN** they hold no `knowledge_claims`
