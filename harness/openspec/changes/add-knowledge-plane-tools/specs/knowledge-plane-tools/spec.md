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

When the host binds a farm lock or a reference store, `knowledge_recommend` MUST join each step of the procedure with the environment: whether the farm holds the package of the step and at which version, and whether the reference store holds the collection the step names and at which path. The tool MUST NOT fill a gap and MUST NOT name a path it did not read. The answer MUST carry a `plan_skeleton`: the procedure folded into plan steps with the id, the name, the track, the agent, the packages, the dependencies, the constraints, the caveats, and the grounding filled. The situation MUST accept an optional `enrichment_input` field, and the answer MUST list in `dropped` the steps a flag removed.

#### Scenario: The farm holds the package and the store holds the collection

- **GIVEN** a farm lock that lists DESeq2 and a reference store that holds the human Hallmark collection
- **WHEN** the planner calls `knowledge_recommend` for a two-group design
- **THEN** the differential expression step reads `environment.package.present: true` with the version, and the enrichment step reads `environment.collection.present: true` with its path

#### Scenario: No store is bound

- **GIVEN** a host that binds no farm lock and no reference store
- **WHEN** the planner calls `knowledge_recommend`
- **THEN** no step carries an environment, and `environment_source` reads unknown for both

### Requirement: A language preference selects the template, never the method

The recommend tool MUST accept an optional `preferred_language` of `R` or `python`. The client MUST send it beside the situation as a preference, never as a situation field. The service MUST select, among the templates of a method whose applicability holds, the first template in the preferred language, and MUST fall back to the first template that holds. A preference MUST NOT change a rule or a method.

#### Scenario: The user asks for Python

- **GIVEN** a two-group design and a user constraint that names Python
- **WHEN** the planner calls `knowledge_recommend` with `preferred_language: python`
- **THEN** the differential expression step names the same method and the Python template of that method

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

`AnalysisStepSchema` and `PlanStepSchema` MUST carry an optional `grounding` object with `status` (`grounded`, `ungrounded`, `flagged`), `snapshot`, `claims`, an optional `template`, and `reason`. A plan without the field MUST validate as before. The briefing MUST render the field beside the task fields.

#### Scenario: A stored plan without grounding loads

- **GIVEN** a plan persisted before the field existed
- **WHEN** it is loaded and validated
- **THEN** validation passes

#### Scenario: A grounded step reaches its agent

- **GIVEN** a step with a grounding that names a template
- **WHEN** the briefing composes
- **THEN** the seed carries the status, the template, the snapshot, the claims, and the reason
