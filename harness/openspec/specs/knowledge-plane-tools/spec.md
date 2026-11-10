# knowledge-plane-tools Specification

## Purpose

The tools that ground a plan on the knowledge service: the optional knowledge client, the recommend and check tools of the planner, and the template tool of a step. The client is an interface that an embedder binds at its composition root, or does not bind. A plan pins one release of the service. A local slot never leaves the machine, and a decision record follows each rendered script.

## Requirements

### Requirement: The knowledge client is an optional interface

The harness MUST declare a `KnowledgeClient` interface with four operations: `recommend(situation)`, `check(situation, steps)`, `render(template, slots, farm?)`, and `contract(template)`. The `contract` operation MUST read `GET /v1/templates/{id}` of the service, and it MUST answer `{ match: "rejected" }` with the field `template` on a 404. The harness MUST ship `createHttpKnowledgeClient({ baseUrl, apiKey })` as the realization over HTTPS with the retry and timeout policy of the other external tools. An embedder MUST bind a client at its composition root, or none. The harness MUST NOT read a license, a key, or an endpoint from the environment.

#### Scenario: No client is bound

- **GIVEN** a composition root that binds no knowledge client
- **WHEN** the planner tools and the sandbox agents are built
- **THEN** no knowledge tool attaches, no description of one enters the context, and every plan validates as before

#### Scenario: A client is bound

- **GIVEN** a composition root that binds a knowledge client
- **WHEN** the planner tools are built
- **THEN** the search tools of the planner hold `knowledge_recommend` and `knowledge_check`

### Requirement: Every service outcome is a data variant

Each operation of the client MUST answer a typed value and MUST NOT throw on a service outcome. An unreachable service, a timeout, a 5xx, or an answer that does not match the contract MUST give `{ match: "unavailable", reason }` after the retry policy. A 400 MUST give `{ match: "rejected", message, issues }` where each issue names the field or the slot and the permitted values.

#### Scenario: The service is unreachable

- **GIVEN** a client at an endpoint that does not answer
- **WHEN** `knowledge_recommend` runs
- **THEN** the tool result is `{ match: "unavailable" }` and the loop continues

#### Scenario: A slot value is refused

- **GIVEN** a render request with a value outside the enumeration of a slot
- **WHEN** `knowledge_template` runs
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

### Requirement: The template tool writes through the mutator

`knowledge_template` MUST send the template reference, the slot values, and the package versions of the farm, and it MUST write the rendered script under `scripts/` and the decision record at `output/decision_record_<script>.json`, one record per rendered script, through the `WorkspaceMutator` of the step with the tool name `knowledge_template`. The tool MUST run in `workflow` execution mode. The tool MUST attach only when a client is bound and the agent holds a mutator.

#### Scenario: A render lands two files

- **GIVEN** a bound client that renders a template
- **WHEN** the tool runs with valid slot values
- **THEN** the script and the decision record exist in the working directory, the result names both paths and the environment match, and the provenance record of each write names `knowledge_template`

The service marks a slot with `read: false` when the script does not read it on this render. The decision record MUST leave such a slot out of `slots`, and it MUST name the slot in `inactive_slots`. The result of the tool MUST keep the slot with its flag, because the value is in the script.

#### Scenario: A slot that the script does not read stays out of the record

- **GIVEN** a render answer with the slot `quantifier` marked `read: false`
- **WHEN** the tool writes the decision record
- **THEN** `slots` of the record does not hold `quantifier`, and `inactive_slots` names it
- **AND** the result of the tool keeps `quantifier` with `read: false`

#### Scenario: A read-only agent gets no template tool

- **GIVEN** an agent built with `readOnly: true`
- **WHEN** its tools resolve
- **THEN** `knowledge_template` is absent

### Requirement: The step briefing carries the template contract

When a plan step grounds on a template and the composition binds a knowledge client, the parent workflow MUST read the contract at dispatch. The read MUST use `contract(template)`, inside the checkpointed step that composes the seed. The child MUST NOT fetch the contract. The seed MUST carry a `Template contract` section with the adaptable slots of the contract only. For each slot the section MUST give the name, the type, the permitted values, and the pattern. It MUST give the default with its source, or the required state. The section MUST list the inputs of the template. When the contract carries notes, the section MUST render them, clamped to `TEMPLATE_NOTES_MAX_CHARS`. The section MUST NOT list a pinned slot. The section MUST render at most `MAX_TEMPLATE_SLOTS` slots, and it MUST clamp each description. The contract can be absent: no client is bound, the service does not answer, or the service does not hold the template. Then the Grounding section MUST carry one line `Template contract: not retrieved (<reason>)`. In that case the seed MUST carry no `Template contract` section, and the child input MUST carry no binding.

#### Scenario: A grounded step with a bound client

- **GIVEN** a plan step whose grounding names `tpl-deseq2-two-group@1.0.0` and a composition that binds a knowledge client
- **WHEN** the parent composes the seed of the step
- **THEN** the seed lists each adaptable slot with its type, its permitted values, and its pattern. Each slot shows its default with the source, or its required state. The seed lists the inputs and no pinned slot

#### Scenario: The contract carries notes

- **GIVEN** a served contract whose notes say that the script renames the condition column to `condition`
- **WHEN** the parent composes the seed of a step that grounds on the template
- **THEN** the `Template contract` section carries the notes whole

#### Scenario: No client, or no answer

- **GIVEN** a plan step whose grounding names a template, and a composition that binds no client or a service that does not answer
- **WHEN** the parent composes the seed
- **THEN** the Grounding section carries `Template contract: not retrieved (<reason>)`, the seed carries no `Template contract` section, and the child input carries no binding

#### Scenario: The served version differs from the plan

- **GIVEN** a plan step whose grounding names version 1.0.0 of a template, and a service that serves version 1.1.0
- **WHEN** the parent composes the seed
- **THEN** the section names the served version beside the reference as a caveat, and it lists each plan setting as unbound. The child input carries no binding

### Requirement: The plan settings bind to the render request

At dispatch the parent MUST intersect the `grounding.settings` of the step with the adaptable slots of the served contract, by name. Each setting that names an adaptable slot MUST become a bound slot of the `templateBinding` of the child input, with its source. The seed MUST list each bound setting under `Bound by the plan` with its value and its source. The seed MUST list each other setting under `Unbound settings` with its procedure step, its source when the setting has one, and the reason. A setting that names a pinned slot with a different value is a pinned conflict. A setting that names no slot stays a plan setting. A setting binds only when its value fits the slot. A fit is a member of the enum of the slot, a number for a number slot, or a boolean for a boolean slot. A free-text slot never binds, because a plan setting can be a policy word and not a value of the slot. A setting that does not fit its slot MUST be listed as unbound with the reason. `knowledge_template` MUST merge the bound slots under the model values. The tool MUST refuse a model value that differs from a bound value when no `overrides` entry names the slot with a reason. The refusal MUST come before the service call, and it MUST name the slot, the bound value, and its source. The decision record on disk MUST carry `bound_slots` and `settings_overrides`.

A departure of the plan changes a setting before the intersection. A setting that a departure names with a value MUST take the value of the departure, with the source `departure from <claim id>`. A setting that a departure names with no value MUST NOT bind. The seed MUST list that setting as unbound, with the claim id and the reason. The binding MUST carry the departures of the step, and the decision record MUST carry them as `departures`.

A rule can give a setting as a policy word, which is not a value of a slot. The served contract can carry `setting_bindings`. Each entry maps one setting with one value to one slot with one slot value. The service gives no more than one entry for one setting with one value, and the parent MUST take the first such entry. The parent MUST bind the slot of an entry when a setting of the step has the name and the value of that entry. The parent MUST read the setting after its departure. Thus a departure that changes the value binds the slot only when an entry maps the new value. A departure with no value MUST NOT bind the slot, and it MUST NOT name the slot as excluded. The source of the bound slot MUST name the setting and the source of the setting. The parent MUST NOT bind the slot of an entry when the slot is not an adaptable slot of the served contract, when the slot is local, or when the slot value does not fit the slot. The seed MUST list that setting as unbound with the reason. A slot takes the first value that binds it. A later setting that gives a different value MUST be listed as unbound.

A script does some settings with no slot, for example the adjustment of a fit script. The served contract can carry `settings_by_construction`. Each entry names one setting with the value that the script does. The service gives no more than one entry for one setting, and the parent MUST take the first such entry. An entry whose setting is the name of a slot of the served contract says nothing, because the slot carries that setting. The parent MUST read the setting after its departure. A setting of the step can have the name and the value of an entry. The seed MUST then list it under `Done by the script` with its procedure step and its source. The seed MUST NOT list that setting as unbound, and the binding MUST NOT hold a slot or a source for it. When the setting has a different value, the seed MUST list it as unbound, and the line MUST name the value that the script does. A departure with no value can name the setting. The seed MUST then list it as unbound, and the line MUST say that the script does it with no slot. The binding MUST NOT name an excluded slot for it. When the served version differs from the version of the plan, the seed MUST list no setting under `Done by the script`.

A template can pin a slot at the value of a setting of the step. The script reads the pinned value, thus the setting needs no act of the agent. The seed MUST then list that setting under `Done by the script` with its procedure step and its source. The line MUST say that the template pins the slot at the same value. The seed MUST NOT list that setting as unbound.

A script can fit the model of a fit in a step before it again. The served contract of such a template can carry `carried_slots`. The entry names the templates of that fit in `from_templates`. It names the slots that the parent binds in `bind`, and the slots that the seed shows in `show`. The parent MUST read the decision records of the steps that the step depends on. A record whose template is in `from_templates` is the record of the reported fit. With one such record, the parent MUST bind each `bind` slot to the value of the same slot in that record. The source of the bound slot MUST name the step and the template of the record. The parent MUST bind a local slot also, and `knowledge_template` binds that value on the machine. The parent MUST NOT bind a slot that has no value in the record, because the default of the template then applies. A setting of the step MUST NOT bind that slot, and the seed MUST list that setting as unbound. The parent MUST NOT bind a value that the slot of the served contract does not take. The seed MUST list that value as unbound with the reason. The seed MUST show the value of each `show` slot, and the binding MUST NOT hold it. A `show` slot is a path, or a slot whose value the script of the fit can change at run time. A carried slot binds before the settings of the step. A setting of the step that gives the slot a different value MUST be listed as unbound. A setting of the step MUST NOT bind a `show` slot, and the seed MUST list that setting as unbound. A departure with no value MUST NOT name a slot that holds a value of the reported fit as excluded. With no such record, or with more than one, the parent MUST bind no carried slot, and the seed MUST give the reason. The parent MUST also bind no carried slot when the record lists a change of the script after the render. The parent MUST compare the digest of the script on disk with the digest in the record. It MUST bind no carried slot when the two differ. The record MUST also hold a run of the rendered script that ended with exit code 0. Such a run is an entry of `runs` whose `sha256` is the `written_sha256` of the record. Without such a run, the parent MUST bind no carried slot, and the seed MUST give the reason. The same applies when the parent did not read each record file of a dependency. In each of these cases, a setting of the step MUST NOT bind a carried slot. When the served version differs from the version of the plan, the parent MUST read no carried slot.

A template gives each slot a value, and an omitted slot takes the default of the template. Thus the binding MUST name an adaptable slot as excluded when a departure with no value names it. `knowledge_template` MUST refuse a render that sends no value for an excluded slot. It MUST also refuse a value with no override. The decision record MUST keep the override of an excluded slot with a `plan_value` of `null`.

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
- **WHEN** the agent calls `knowledge_template` with the template and the paths only
- **THEN** the render request carries `lfc_shrink = apeglm`, and the decision record lists it under `bound_slots` with its source

#### Scenario: A changed value without an override is refused

- **GIVEN** a child input whose binding holds `lfc_shrink = apeglm`
- **WHEN** the agent calls `knowledge_template` with `lfc_shrink = ashr` and no `overrides` entry
- **THEN** the tool answers `{ match: "rejected" }` before the service call, the issue names `lfc_shrink`, the value `apeglm`, and its source, and no file is written

#### Scenario: An override with a reason renders

- **GIVEN** a child input whose binding holds `lfc_shrink = apeglm`
- **WHEN** the agent calls `knowledge_template` with `lfc_shrink = ashr` and an `overrides` entry that names `lfc_shrink` with a reason
- **THEN** the script renders with `ashr`. The decision record lists the change under `settings_overrides` with the plan value, the new value, and the reason

#### Scenario: A departure changes a bound value

- **GIVEN** a step whose settings hold `min_count = 10`, and a departure from `R-0001@e7d0` that gives `min_count = 5`
- **WHEN** the seed composes against a contract whose `min_count` slot is an integer
- **THEN** the binding holds `min_count = 5` with the source `departure from R-0001@e7d0`
- **AND** the decision record of the render lists the departure

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

#### Scenario: A slot that takes the value of the reported fit

- **GIVEN** a step that depends on `T1S2`, and a served contract whose `carried_slots` name `tpl-fit`, bind `min_count`, and show `counts_path`
- **AND** one decision record of `tpl-fit@2.0.0` in `T1S2` whose slots hold `min_count = 5` and a value of `counts_path`
- **AND** the record holds a run of the rendered script that ended with exit code 0
- **WHEN** the seed composes
- **THEN** the binding holds `min_count = 5`, and its source names `T1S2` and `tpl-fit@2.0.0`
- **AND** the seed shows the value of `counts_path`, and the binding does not hold it

#### Scenario: A setting of the step that differs from the reported fit

- **GIVEN** the same step, and a setting of the step that gives `min_count = 10`
- **WHEN** the seed composes
- **THEN** the binding holds `min_count = 5`, and the seed lists the setting as unbound

#### Scenario: No one record of the reported fit

- **GIVEN** the same contract, and no decision record of `tpl-fit` in the steps that the step depends on
- **WHEN** the seed composes
- **THEN** the binding holds no carried slot, and the seed gives the reason
- **WHEN** those steps hold two decision records of `tpl-fit`
- **THEN** the binding holds no carried slot, and the seed names the two records

#### Scenario: A fit script that changed after its render

- **GIVEN** the same contract, and one decision record of `tpl-fit` whose `unvetted_edits` hold an entry
- **WHEN** the seed composes
- **THEN** the binding holds no carried slot, and the seed names the record and gives the reason

#### Scenario: A render of the fit that did not run

- **GIVEN** the same contract, and one decision record of `tpl-fit` with no entry in `runs`
- **WHEN** the seed composes
- **THEN** the binding holds no carried slot, and the seed names the record and gives the reason
- **WHEN** the only run of the record ended with exit code 1, or ran different bytes
- **THEN** the binding holds no carried slot

#### Scenario: A render of an excluded slot

- **GIVEN** a binding that names `lfc_shrink` as excluded
- **WHEN** the model renders with no `lfc_shrink`, or with `lfc_shrink` and no override
- **THEN** `knowledge_template` refuses the render
- **WHEN** the model renders with `lfc_shrink = none` and an override with the reason
- **THEN** the decision record keeps the override with a `plan_value` of `null`

### Requirement: The plan step carries an optional grounding

`AnalysisStepSchema` and `PlanStepSchema` MUST carry an optional `grounding` object with `status` (`grounded`, `ungrounded`, `flagged`), `snapshot`, `claims`, an optional `template`, an optional `settings` list, and `reason`. The object MUST also carry an optional `departures` list. Each entry of `settings` MUST carry the procedure step, the name, the value, and an optional source. The value is a string, a number, a boolean, or a list of strings. The planner MUST copy `settings` from the skeleton step as it is. A plan without the field MUST validate as before. The briefing MUST render the field beside the task fields.

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

### Requirement: The planner restores the template of a skeleton step

The recommend tool MUST give each answer to the planner invocation that holds it. `submit_plan` MUST restore an absent `grounding.template` of a candidate step from the skeleton step with the same id. The restore applies only when the snapshot digest of the candidate step equals the snapshot of the skeleton. The restore MUST NOT change a step that carries a template, a step with a different snapshot, or a step the skeleton does not hold. `submit_plan` MUST stamp the snapshot digest of the answer on a skeleton step, and on a step the skeleton does not hold when one of its claims is a claim of the answer. A step with no claim of the answer keeps the digest it carries. A step whose snapshot is `none` is never stamped. The tool MUST log the ids of the restored steps and of the stamped steps.

#### Scenario: The model drops the template

- **GIVEN** a recommend answer whose differential expression skeleton step names `tpl-deseq2-two-group@1.0.0`
- **WHEN** the planner submits that step with the claims, the snapshot, and no `template`
- **THEN** the stored step carries `grounding.template: tpl-deseq2-two-group@1.0.0`

#### Scenario: A different snapshot is left as it is

- **GIVEN** the same answer
- **WHEN** the planner submits a step with the same id and a snapshot of `none`
- **THEN** the stored step carries no template

#### Scenario: A step outside the skeleton cites a claim of the answer

- **GIVEN** the same answer
- **WHEN** the planner submits a robustness step under an id the skeleton does not hold, with a claim of the answer and a miscopied digest
- **THEN** the stored step carries the digest of the answer, and a step with no claim of the answer keeps the digest it carried

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

### Requirement: A local slot never leaves the machine

A slot the contract marks `local` (a path, a column name, a level label, a design formula) MUST NOT be sent to the service. `knowledge_template` MUST take the local slots from the `templateBinding` of the step, or from the contract when the binding carries none, and it MUST send the other slots only. The service answers with the marker `{{name}}` in each local slot, and the tool MUST bind the local values on the machine with the rule of the service (`bindLocalSlots`) before it writes the script. A local value the contract refuses MUST be refused by the tool, with the slot and the reason, before any write. The reason MUST end with the description of the slot, thus the agent reads the intent of a pattern beside the pattern. The briefing MUST mark each local slot.

#### Scenario: A path stays on the machine

- **GIVEN** a render call with `counts_path` and `lfc_shrink`
- **WHEN** the tool calls the service
- **THEN** the request carries `lfc_shrink` only, the written script carries the count path in the marked line, and the record names `counts_path` as bound on this machine

#### Scenario: A local value the contract refuses

- **GIVEN** a render call whose `counts_path` is a number
- **WHEN** the tool binds the local slots
- **THEN** the tool answers `match: rejected` with the slot and the reason, and no file is written

#### Scenario: A formula the pattern refuses

- **GIVEN** a local `design` slot with the pattern `condition\s*$` and the description "The design formula. It must end with condition."
- **WHEN** the agent sends `~ squamous + response`
- **THEN** the issue of `design` gives the pattern and the description of the slot, and the tool calls no service

### Requirement: The decision record follows the script

The record on disk MUST carry the step, the claims, the digest of the script as the service rendered it, and `written_sha256`, the digest of the bytes the tool wrote. `edit_file` on a script under `scripts/` that has a record MUST append an entry to `unvetted_edits` with the path, a note, and the digest after the change. Before `execute_command` runs a script that has a record, it MUST compare the script with the last recorded digest, and a difference MUST be appended as an unvetted change with the digest of the bytes that run. A script without a record is untouched.

A command can name its script inside a shell line: the one element of an `sh -c` call, or a string after `bash -c`. `execute_command` MUST find each word of such a line that has a script extension. It MUST make the same comparison for each one. A word ends at whitespace, at a shell operator, at a quote, and at the `=` of an option. A `cd` in the line moves the words after it, and a subshell can end that move. Thus `execute_command` MUST resolve a relative word against the cwd of the command. It MUST also resolve the word against each directory that a `cd` before the word can give. The command MUST run as the model sent it.

Before `execute_command` runs a script that has a record, it MUST append an entry to `runs` in the record. The entry MUST hold `sha256`, the digest that the comparison before the run read, and `invocation`, the id of the tool call. After the command, the tool MUST add `exit_code`, the exit code of the command, to that entry. An entry with no `exit_code` is a run that did not end, and it MUST NOT count as a good run. A tool call that the host does again after a recovery MUST write no second entry. The entry from before the command does not say if the command ran before the host stopped. Thus that call MUST compare its digest with the digest of the entry. When the two agree, the entry keeps `sha256`. When the two differ, the entry MUST hold `sha256_before_the_command` and `sha256_at_the_recovery`, and it MUST hold no `sha256`. Such an entry is a run of no known script, and it MUST NOT count as a good run. If the write before the command fails, the tool MUST append the entry after the command. The tool MUST write the entries of one record in order, thus two commands that end together lose no entry. The tool MUST NOT read the script again after the run, because the run can change the script. The tool MUST write the entry only when the exit code of the command is the exit code of the script. A direct argv gives that when the script is the command. It also gives that when the script comes after a runner, for example `Rscript`, `python`, or `bash`. Only an option that still runs the script can be between the two, for example `--vanilla`. An option such as `--version` or `-e` MUST write no entry. A `cd` in a chain of `&&` moves the script, and a `cd` that the host cannot resolve MUST write no entry. A shell line gives that only when it is one such command, or a chain of `&&` that ends with one. Each command before the last one of a chain MUST be `cd` with one directory or `mkdir -p` with one directory. An output redirect and `2>&1` are permitted after the command. A line with a pipe, a list, a subshell, a quote, an expansion, or an input redirect MUST write no entry. A command that reads the script as data, for example `cat`, MUST write no entry. A failed write of the entry MUST NOT fail the call, because the command already ran. A record MUST keep no more than its last 50 entries.

#### Scenario: An edit lands on the record

- **GIVEN** a rendered script and its record
- **WHEN** `edit_file` changes a marked line
- **THEN** the record lists the edit with the digest of the script after the change

#### Scenario: A change no tool recorded

- **GIVEN** a rendered script whose bytes differ from the last recorded digest
- **WHEN** `execute_command` runs it
- **THEN** the record lists the change with the digest of the bytes that run, before the command runs

#### Scenario: A changed script in a shell line

- **GIVEN** a rendered script whose bytes differ from the last recorded digest
- **WHEN** `execute_command` runs the one element `cd scripts && Rscript de.R > log.txt`
- **THEN** the record lists the change with the digest of the bytes that run, before the command runs
- **AND** the command runs with no change

#### Scenario: A run lands on the record

- **GIVEN** a rendered script and its record
- **WHEN** `execute_command` runs `Rscript scripts/de.R`, and the command ends with exit code 0
- **THEN** the two copies of the record hold a `runs` entry with `exit_code` 0 and the digest of the script
- **WHEN** `execute_command` runs `cat scripts/de.R`, or the one element `Rscript scripts/de.R | tee log.txt`
- **THEN** the record gets no entry

#### Scenario: A recovered call of a changed script names no script digest

- **GIVEN** a record with a `runs` entry of a tool call that holds a digest and no `exit_code`
- **AND** a script that now holds different bytes
- **WHEN** the host does that tool call again, and the command ends with exit code 0
- **THEN** the entry holds `exit_code` 0, `sha256_before_the_command`, and `sha256_at_the_recovery`
- **AND** the entry holds no `sha256`, thus no carried slot binds from it
- **AND** the record holds one entry of that tool call
- **WHEN** the script holds the same bytes at the recovery
- **THEN** the entry holds `exit_code` 0 and `sha256`

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

### Requirement: The briefing gives the methods of each upstream step

At dispatch the parent MUST give the handoff of each completed dependency the methods of that dependency. The methods come from the grounding of its plan step, the claim views of the run input, and the host copies of its records. The read of the records MUST be the confined and bounded read of the methods of a step. The handoff MUST render the grounding and the snapshot digest, each template with its method, and the rules and the sources of the dependency. The handoff MUST also render the departures of the dependency. The rules, the departures, and the sources MUST each be bounded by `UPSTREAM_METHODS_MAX_ITEMS`, with a count of the tail. The handoff MUST also list the in-sandbox path of the copy in the step of each decision record, bounded by `MAX_UPSTREAM_DECISION_RECORDS`. A dependency with no grounding and no record MUST render as before.

#### Scenario: A report step after a grounded step

- **GIVEN** a step `T1S1` with a grounding that cites `R-0001@e7d0`, and a decision record of `tpl-deseq2-two-group@1.0.0` with one DOI
- **WHEN** the parent composes the seed of a step that depends on `T1S1`
- **THEN** the handoff of `T1S1` renders the grounding, the template with its method, the title of `R-0001@e7d0`, and the DOI
- **AND** the handoff lists the path of the decision record

#### Scenario: A dependency with no methods

- **WHEN** the parent composes the seed of a step whose dependency has no grounding and no decision record
- **THEN** the handoff of the dependency has no grounding line and no decision record line

#### Scenario: A dependency with a departure

- **GIVEN** a dependency whose grounding departs from `R-0028@d560` with `n_top_genes_pca = 364`
- **WHEN** the parent composes the seed of a step that depends on it
- **THEN** the handoff lists the departure with the rule, the setting, the value of the plan, and the reason

### Requirement: The host keeps a copy of each decision record

Each write of a decision record MUST land two copies with the same bytes. The copy in the step stays at `output/decision_record_<script>.json`. The host copy MUST go under `.sandbox/decision-records/`, at the analysis-relative path of the copy in the step. The copy in the step MUST land first, through the mutator of the tool. The host copy MUST land after it, with the hardened landing of the mutator. A write of a host copy records no provenance, because the copy in the step carries it.

`knowledge_template` MUST write the host copy of each record that it writes. `edit_file` and `execute_command` MUST read the host copy of a record first. A change note MUST land in both copies. When the mutator refuses the copy in the step, the note MUST still land in the host copy. A host write MUST take only a record whose copy is under the write prefix of the caller. Thus a tool of one step never writes a record of another step. A record with no host copy is a record that an earlier version wrote. The tools MUST note a change in such a record in the copy in the step only. Thus a file in the step never becomes a host record.

Before `execute_command` runs a script, it MUST compare the copy in the step with the host copy. When the copy in the step is absent or differs, the tool MUST write it again from the host copy. The result MUST name each such record in `decision_records_restored`, and the host MUST log a warning. After the agent loop, the host MUST write again each absent or changed copy in the step, before the walk of the artifacts. The host MUST NOT follow a symbolic link in place of a copy. After that restore, the provenance record of a copy MUST stay only when a file tool wrote the same bytes. Otherwise the file falls to the step activity, because no other producer wrote those bytes.

#### Scenario: A command removed the records of the step

- **GIVEN** a rendered script, and its record in the step and on the host
- **AND** a command removed `output/decision_record_de.json`
- **WHEN** `execute_command` runs the script
- **THEN** the copy in the step has the bytes of the host copy again before the script runs
- **AND** the result names the record in `decision_records_restored`

#### Scenario: A command changed the copy in the step

- **GIVEN** a host record with the digest of the rendered script
- **AND** a copy in the step that claims the digest of changed bytes
- **WHEN** `execute_command` runs the changed script
- **THEN** the host copy lists the change with the digest of the bytes that run
- **AND** the copy in the step has the bytes of the host copy

#### Scenario: A symlink in place of the copy in the step

- **GIVEN** a host record, and a symlink in place of its copy in the step
- **WHEN** `execute_command` runs a changed script of that record
- **THEN** the host copy lists the change, and the target of the symlink stays unchanged

#### Scenario: A changed script of another step

- **GIVEN** a step `step0` with a host record, and a script that differs from the digest of the record
- **WHEN** `execute_command` of another step runs that script
- **THEN** the host copy and the copy in `step0` stay unchanged

#### Scenario: A record that an earlier version wrote

- **GIVEN** a record in the step with no host copy
- **WHEN** `execute_command` runs a changed script of that record
- **THEN** the copy in the step lists the change, and the host holds no copy of the record

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