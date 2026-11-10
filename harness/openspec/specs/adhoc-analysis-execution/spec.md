# adhoc-analysis-execution Specification

## Purpose
How the conversation agent launches an analysis through the one `execute_analysis` tool, from an approved plan or from an ad hoc request. An ad hoc request becomes an internal plan of one step, on the agent and with the packages that the tool input names. The stable tool invocation id names the run, thus a second delivery of one invocation starts no second run.

## Requirements

### Requirement: Unified analysis tool selects plan or ad hoc execution

The conversation-agent roster MUST expose `execute_analysis` as the sole general analysis launch tool. Its flat
object input MUST contain `mode` plus the fields of that mode: `{ mode: "plan", planId }`, or
`{ mode: "adhoc", request, agent?, packages? }`. Plan mode MUST resolve and validate the approved stored plan of
`planId`. Ad hoc mode MUST construct one internal step from `request`. Both modes MUST return a `runId` after an
asynchronous launch. They MUST leave the retrieval of the result to the run-inspection tools.

#### Scenario: Approved plan launches by id

- **GIVEN** the user approved a stored plan
- **WHEN** the conversation agent calls `execute_analysis` with `mode = "plan"` and that `planId`
- **THEN** the tool validates and launches the stored plan with its existing plan-execution semantics

#### Scenario: Ad hoc request launches one step

- **GIVEN** the user explicitly requested a targeted computation
- **WHEN** the conversation agent calls `execute_analysis` with `mode = "adhoc"` and the request
- **THEN** the tool asynchronously launches one analysis step and returns its `runId`
- **AND** it does not await the computation inside the chat turn

#### Scenario: Mode-specific input is exact

- **WHEN** a call supplies neither `planId` nor `request`, both of them, the field of the other mode, or `agent` or `packages` in plan mode
- **THEN** input validation rejects the call before persistence, authorization, or launch

### Requirement: Explicit computational intent authorizes ad hoc launch

An explicit user instruction SHALL authorize one ad hoc launch when it asks the
agent to run, compute, test, compare, or otherwise execute a targeted analysis, without a
generated plan card or second approval. When computation is only the
conversation agent's suggestion or inference, it SHALL ask the user before
calling `execute_analysis`; the tool SHALL NOT be invoked speculatively.

#### Scenario: User directly asks for computation

- **GIVEN** the user says to calculate a statistic from the staged inputs
- **WHEN** the conversation agent handles the request
- **THEN** it MAY call ad hoc `execute_analysis` without asking the user to approve an internal plan

#### Scenario: Agent proposes additional computation

- **GIVEN** the user asked a conceptual question and did not request execution
- **WHEN** the conversation agent believes a computation would improve the answer
- **THEN** it asks for consent before calling ad hoc `execute_analysis`

### Requirement: Internal plan is mechanical and not an approval artifact

Ad hoc mode MUST persist an `AnalysisPlan` with one step and no dependencies. The step MUST carry the request as
the analytical question, the agent of the tool input, and the validated packages of the tool input. It MUST carry no
resources. It MUST carry the iteration limit of its agent. It MUST carry the acceptance criteria for a
reproducible script, result artifacts, and a direct answer. The caveats of the step MUST name each dropped package
entry with its reason. When the step declares no packages, the caveats MUST say so, because the link pass then links
nothing. The launch record MUST carry the count of the package queries that the link pass sent. Harness code MUST
make the plan deterministically, with no model call. The plan MUST NOT go to the user for approval, and it MUST NOT
show as planning intent of the user.

The internal plan id MUST derive from analysis and tool invocation identity.
Persistence MUST be insert-if-absent. After any insert race, each caller MUST
reload the stored plan so the first persisted plan wins.

#### Scenario: New invocation creates one-step bookkeeping

- **WHEN** an ad hoc invocation has no stored internal plan
- **THEN** the harness constructs and validates a single no-dependency step on the agent of the input, and persists it before run reservation
- **AND** no model call, planner call, or plan approval occurs

#### Scenario: Concurrent duplicate routing converges

- **GIVEN** two deliveries of the same invocation race before its internal plan exists
- **WHEN** both attempt insert-if-absent
- **THEN** exactly one plan row survives and both deliveries reload that same stored step

#### Scenario: The step carries the validated packages

- **WHEN** the tool input holds `["scanpy", "python:igraph"]`
- **THEN** the stored step carries that array, and the link pass receives two queries

#### Scenario: A step with no packages says so

- **WHEN** the tool input holds no packages
- **THEN** the stored step carries an empty array, the seam is not called, and a caveat says that the step declares no packages

### Requirement: Ad hoc runs use the ordinary one-step lifecycle without synthesis

An ad hoc launch MUST pass its internal plan through `executeAnalysis` and the
ordinary writable sandbox-step workflow. It MUST use the normal parts of a run:

- authorization, billing, recovery, and cancellation
- the lease admission of its sandbox, and the step briefing
- summary and metadata interpretation, artifact registration, and sync/indexing
- run cards, run/step ledgers, and pull-based inspection

A successful step MUST
persist reproducible script and result files even when its answer is a single
scalar.

The workflow input MUST set `synthesisEnabled = false`. The run MUST have no
synthesis ledger row and no synthesis call. The successful completion of the one
step MUST let the run complete.

#### Scenario: Scalar computation remains reproducible

- **WHEN** an ad hoc step computes one numeric answer successfully
- **THEN** its writable step directory contains the script and result artifact
- **AND** the step summary and run inspection expose the answer

#### Scenario: Ad hoc run has exactly one visible step

- **WHEN** the run and step ledgers are inspected after ad hoc launch
- **THEN** they contain the one normal analysis step and no synthesis row

#### Scenario: The ad hoc step acquires its own sandbox

- **WHEN** the agent of an ad hoc step calls `acquire_sandbox`
- **THEN** the lease of the step waits in the same queue as the lease of a planned step

### Requirement: Invocation identity distinguishes delivery retry from re-execution

The stable tool invocation id SHALL be the semantic idempotency boundary for ad
hoc launch. The harness SHALL derive the run/workflow id from tool name,
analysis id, and invocation id. Duplicate delivery of that invocation SHALL
resolve to the same run and DBOS workflow even after the run is terminal. A
distinct invocation SHALL create a distinct run regardless of whether its
request text equals an earlier request.

#### Scenario: Same invocation is delivered twice

- **WHEN** one ad hoc tool call is dispatched twice with the same invocation id
- **THEN** both deliveries return the same `runId`
- **AND** DBOS executes at most one workflow under that id

#### Scenario: Agent deliberately calls again

- **GIVEN** an earlier ad hoc invocation used request text `R`
- **WHEN** the agent issues a later tool call with a new invocation id and the same text `R`
- **THEN** the later call creates a new run

### Requirement: The ad hoc input selects the agent of the step

The `agent` of an ad hoc tool input MUST be `analyst` or `drug-analyst`. When the input has no `agent`, the step MUST
run on `analyst`. The harness MUST make no model call to select the agent. It MUST record no usage under a router
agent id.

#### Scenario: An input with no agent runs on the analyst

- **WHEN** the conversation agent calls ad hoc `execute_analysis` with no `agent`
- **THEN** the internal step names `analyst`

#### Scenario: An input can name the drug analyst

- **WHEN** the conversation agent calls ad hoc `execute_analysis` with `agent = "drug-analyst"` for a question about the exposure of a compound
- **THEN** the internal step names `drug-analyst`

#### Scenario: An unknown agent is refused

- **WHEN** the input names an agent other than `analyst` or `drug-analyst`
- **THEN** input validation refuses the call before persistence, authorization, or launch

### Requirement: The ad hoc input carries the packages of the step

The `packages` of an ad hoc tool input MUST obey the one package grammar of the planner. The harness MUST validate
each entry apart from the others. It MUST drop an entry that does not parse, and it MUST record each dropped entry
with its reason.

#### Scenario: A package that is a path is dropped

- **GIVEN** a tool input with a package entry that is a path
- **WHEN** the harness validates the packages
- **THEN** the entry is dropped as unparsable, the drop is recorded, and the step launches

### Requirement: The pool resolves the ad hoc packages

When a resolution of the names is bound, the harness MUST drop a name that the pool does not hold. It MUST use the
known spelling of a name. It MUST keep a name that both tracks hold as written. When no resolution is bound, or the
inventory is unavailable, each entry that parses MUST stay.

#### Scenario: An absent name leaves the step with a caveat

- **GIVEN** a bound resolution that answers absent for one name and gives no suggestion
- **WHEN** the harness validates the packages
- **THEN** the step does not carry that name, and its caveats name the drop

#### Scenario: A known spelling replaces the entry

- **GIVEN** a bound resolution that answers absent for `seurat` with the suggestion `Seurat`
- **WHEN** the harness validates the packages
- **THEN** the step carries `Seurat`

#### Scenario: A bare both-track name reaches the link pass

- **GIVEN** the tool input holds the bare name `xgboost`, and both tracks hold it
- **WHEN** the launch runs the link pass with a bound seam
- **THEN** the launch refuses with the two prefixed forms, and no run reserves
