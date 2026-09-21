## ADDED Requirements

### Requirement: The knowledge client is an optional seam

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

### Requirement: The recommend answer carries the environment and a plan skeleton

When the host binds a farm lock or a reference store, `knowledge_recommend` MUST join each step of the procedure with the environment. The environment says whether the farm holds the package of the step, and at which version. It says whether the reference store holds the collection the step names, and at which path. The tool MUST NOT fill a gap and MUST NOT name a path it did not read.

The tool MUST give the planner one representation: `plan_skeleton` and `claims`. The model-facing answer MUST NOT carry the `procedure` of the service. `plan_skeleton` MUST be the procedure folded into plan steps. When the procedure holds a `cohort_assembly` step, the fold MUST put it in one step before the QC step, and the QC step MUST depend on it. Each skeleton step MUST carry these fields, filled from the procedure:

- the id, the name, the track, the agent, the packages, and the dependencies
- the constraints and the caveats
- the `alternatives` of the central step, the `disputed` sides, and the `forbids` list
- the `environment` of the central step
- the grounding, with `settings` filled

Each entry of `settings` is one parameter of a procedure step of the group. The entry MUST name the procedure step, the name, the value, and the source.

`claims` MUST hold only the claims the procedure references, in match order. A referenced claim is a rule of a step, a flag, an alternative, or a disputed rule. The full view of a claim is at `GET /v1/claims/{claim}` of the service, and the tool MUST NOT fetch it. The situation MUST accept an optional `enrichment_input` field, and the answer MUST list in `dropped` the steps a flag removed.

#### Scenario: The farm holds the package and the store holds the collection

- **GIVEN** a farm lock that lists DESeq2 and a reference store that holds the human Hallmark collection
- **WHEN** the planner calls `knowledge_recommend` for a two-group design
- **THEN** the differential expression skeleton step reads `environment.package.present: true` with the version, and the enrichment skeleton step reads `environment.collection.present: true` with its path

#### Scenario: No store is bound

- **GIVEN** a host that binds no farm lock and no reference store
- **WHEN** the planner calls `knowledge_recommend`
- **THEN** no skeleton step carries an environment, and `environment_source` reads unknown for both

#### Scenario: The planner receives one representation

- **GIVEN** a two-group design whose differential expression rule names an alternative method, a forbidden method, and the alpha of the test with its source
- **WHEN** the planner calls `knowledge_recommend`
- **THEN** the answer carries `plan_skeleton` and `claims` and no `procedure`. The differential expression skeleton step carries the alternative in `alternatives`, the forbidden method in `forbids`, and the alpha with its step and source in `grounding.settings`. Each claim id a skeleton step cites has one view in `claims`.

### Requirement: A language preference selects among the templates that honor the design

The recommend tool MUST accept an optional `preferred_language` of `R` or `python`. The client MUST send it beside the situation as a preference, never as a situation field. A preference MUST NOT change a rule. The service MUST select among the templates of the method that hold and honor the design requirements of the situation. In that set, the service MUST select the first template in the preferred language.

When that template is a declared substitute, the answer MUST name the substitute as the method of the step. The step MUST carry the package and the template of the substitute, and `substitution.for` MUST name the method of record. When no template of the preferred language holds, the answer MUST keep the first template that holds. That step MUST report `limit` with the requested language and each skipped template with the requirement it lacks. The plan skeleton MUST render a substitution and a limit as a caveat of the step, never as a constraint.

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

#### Scenario: A read-only agent gets no template tool

- **GIVEN** an agent built with `readOnly: true`
- **WHEN** its tools resolve
- **THEN** `knowledge_template` is absent

### Requirement: The step briefing carries the template contract

When a plan step grounds on a template and the composition binds a knowledge client, the parent workflow MUST read the contract at dispatch. The read MUST use `contract(template)`, inside the checkpointed step that composes the seed. The child MUST NOT fetch the contract. The seed MUST carry a `Template contract` section with the adaptable slots of the contract only. For each slot the section MUST give the name, the type, the permitted values, and the pattern. It MUST give the default with its source, or the required state. The section MUST list the inputs of the template. The section MUST NOT list a pinned slot. The section MUST render at most `MAX_TEMPLATE_SLOTS` slots, and it MUST clamp each description. The contract can be absent: no client is bound, the service does not answer, or the service does not hold the template. Then the Grounding section MUST carry one line `Template contract: not retrieved (<reason>)`. In that case the seed MUST carry no `Template contract` section, and the child input MUST carry no binding.

#### Scenario: A grounded step with a bound client

- **GIVEN** a plan step whose grounding names `tpl-deseq2-two-group@1.0.0` and a composition that binds a knowledge client
- **WHEN** the parent composes the seed of the step
- **THEN** the seed lists each adaptable slot with its type, its permitted values, and its pattern. Each slot shows its default with the source, or its required state. The seed lists the inputs and no pinned slot

#### Scenario: No client, or no answer

- **GIVEN** a plan step whose grounding names a template, and a composition that binds no client or a service that does not answer
- **WHEN** the parent composes the seed
- **THEN** the Grounding section carries `Template contract: not retrieved (<reason>)`, the seed carries no `Template contract` section, and the child input carries no binding

#### Scenario: The served version differs from the plan

- **GIVEN** a plan step whose grounding names version 1.0.0 of a template, and a service that serves version 1.1.0
- **WHEN** the parent composes the seed
- **THEN** the section names the served version beside the reference as a caveat, and it lists each plan setting as unbound. The child input carries no binding

### Requirement: The plan settings bind to the render request

At dispatch the parent MUST intersect the `grounding.settings` of the step with the adaptable slots of the served contract, by name. Each setting that names an adaptable slot MUST become a bound slot of the `templateBinding` of the child input, with its source. The seed MUST list each bound setting under `Bound by the plan` with its value and its source. The seed MUST list each other setting under `Unbound settings` with the reason. A setting that names a pinned slot with a different value is a pinned conflict. A setting that names no slot stays a plan setting. A setting binds only when its value fits the slot. A fit is a member of the enum of the slot, a number for a number slot, or a boolean for a boolean slot. A free-text slot never binds, because a plan setting can be a policy word and not a value of the slot. A setting that does not fit its slot MUST be listed as unbound with the reason. `knowledge_template` MUST merge the bound slots under the model values. The tool MUST refuse a model value that differs from a bound value when no `overrides` entry names the slot with a reason. The refusal MUST come before the service call, and it MUST name the slot, the bound value, and its source. The decision record on disk MUST carry `bound_slots` and `settings_overrides`.

#### Scenario: A policy word on an integer slot

- **GIVEN** a step whose settings hold `min_samples = smallest_group_size` and `min_count = 10`
- **WHEN** the seed composes against a contract whose two slots are integers
- **THEN** the binding holds `min_count = 10` and not `min_samples`, and the seed lists `min_samples` as unbound with the reason

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

### Requirement: The plan step carries an optional grounding

`AnalysisStepSchema` and `PlanStepSchema` MUST carry an optional `grounding` object with `status` (`grounded`, `ungrounded`, `flagged`), `snapshot`, `claims`, an optional `template`, an optional `settings` list, and `reason`. Each entry of `settings` MUST carry the procedure step, the name, the value, and an optional source. The value is a string, a number, a boolean, or a list of strings. The planner MUST copy `settings` from the skeleton step as it is. A plan without the field MUST validate as before. The briefing MUST render the field beside the task fields.

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

The two planner tools of one plan generation MUST share one pin. The first `knowledge_recommend` answer MUST set the pin to the served snapshot digest. Each later call of `knowledge_recommend` and `knowledge_check` in the same plan MUST send the pin as `expected_snapshot`. `knowledge_template` MUST send the snapshot digest of the grounding of its step as `expected_snapshot`, with the step id and the claims of the step. A 409 of the service MUST be the data variant `snapshot_mismatch`, with the expected and the served digests, and the tool MUST do no work on it. The render call of `knowledge_template` MUST run in a durable step, thus a replay of the step reads the cached answer and writes the same bytes.

#### Scenario: The service moves between two calls

- **GIVEN** a plan whose first recommend answer came from release A, and a service that now serves release B
- **WHEN** the planner calls `knowledge_check`
- **THEN** the tool answers `match: snapshot_mismatch` with the two digests, and the planner submits the draft as it is

#### Scenario: A replay renders the same bytes

- **GIVEN** a step that rendered a template and a workflow that recovers
- **WHEN** the step replays its `knowledge_template` call
- **THEN** the render answer comes from the cached step, and the script and the record hold the same bytes as the first run

### Requirement: A local slot never leaves the machine

A slot the contract marks `local` (a path, a column name, a level label, a design formula) MUST NOT be sent to the service. `knowledge_template` MUST take the local slots from the `templateBinding` of the step, or from the contract when the binding carries none, and it MUST send the other slots only. The service answers with the marker `{{name}}` in each local slot, and the tool MUST bind the local values on the machine with the rule of the service (`bindLocalSlots`) before it writes the script. A local value the contract refuses MUST be refused by the tool, with the slot and the reason, before any write. The briefing MUST mark each local slot.

#### Scenario: A path stays on the machine

- **GIVEN** a render call with `counts_path` and `lfc_shrink`
- **WHEN** the tool calls the service
- **THEN** the request carries `lfc_shrink` only, the written script carries the count path in the marked line, and the record names `counts_path` as bound on this machine

#### Scenario: A local value the contract refuses

- **GIVEN** a render call whose `counts_path` is a number
- **WHEN** the tool binds the local slots
- **THEN** the tool answers `match: rejected` with the slot and the reason, and no file is written

### Requirement: The decision record follows the script

The record on disk MUST carry the step, the claims, the digest of the script as the service rendered it, and `written_sha256`, the digest of the bytes the tool wrote. `edit_file` on a script under `scripts/` that has a record MUST append an entry to `unvetted_edits` with the path, a note, and the digest after the change. Before `execute_command` runs a script that has a record, it MUST compare the script with the last recorded digest, and a difference MUST be appended as an unvetted change with the digest of the bytes that run. A script without a record is untouched.

#### Scenario: An edit lands on the record

- **GIVEN** a rendered script and its record
- **WHEN** `edit_file` changes a marked line
- **THEN** the record lists the edit with the digest of the script after the change

#### Scenario: A change no tool recorded

- **GIVEN** a rendered script whose bytes differ from the last recorded digest
- **WHEN** `execute_command` runs it
- **THEN** the record lists the change with the digest of the bytes that run, before the command runs
