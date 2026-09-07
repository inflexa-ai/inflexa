## ADDED Requirements

### Requirement: The knowledge client is an optional seam

The harness MUST declare a `KnowledgeClient` interface with three operations: `recommend(situation)`, `check(situation, steps)`, and `render(template, slots, farm?)`. The harness MUST ship `createHttpKnowledgeClient({ baseUrl, apiKey })` as the realization over HTTPS with the retry and timeout policy of the other external tools. An embedder MUST bind a client at its composition root, or none. The harness MUST NOT read a license, a key, or an endpoint from the environment.

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

The tool MUST give the planner one representation: `plan_skeleton` and `claims`. The model-facing answer MUST NOT carry the `procedure` of the service. `plan_skeleton` MUST be the procedure folded into plan steps. Each skeleton step MUST carry these fields, filled from the procedure:

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

The input of `knowledge_recommend` and `knowledge_check` MUST be the flat situation schema: enumerated fields for the question, the modality, the data state, the count source, the organism, the batch structure, the library type, the strandedness, and the quality flags, plus the group and replicate counts, the pairing, the blocking factor, the covariates, the time points, and the interaction flag. The tool MUST NOT accept a sample identifier, a file path, or free text.

#### Scenario: An absent optional field is omitted

- **GIVEN** a call without `covariates`
- **WHEN** the tool sends the situation
- **THEN** the request carries no `covariates` key

### Requirement: The template tool writes through the mutator

`knowledge_template` MUST send the template reference, the slot values, and the package versions of the farm, and it MUST write the rendered script under `scripts/` and the decision record at `output/decision_record.json` through the `WorkspaceMutator` of the step with the tool name `knowledge_template`. The tool MUST run in `workflow` execution mode. The tool MUST attach only when a client is bound and the agent holds a mutator.

#### Scenario: A render lands two files

- **GIVEN** a bound client that renders a template
- **WHEN** the tool runs with valid slot values
- **THEN** the script and the decision record exist in the working directory, the result names both paths and the environment match, and the provenance record of each write names `knowledge_template`

#### Scenario: A read-only agent gets no template tool

- **GIVEN** an agent built with `readOnly: true`
- **WHEN** its tools resolve
- **THEN** `knowledge_template` is absent

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
