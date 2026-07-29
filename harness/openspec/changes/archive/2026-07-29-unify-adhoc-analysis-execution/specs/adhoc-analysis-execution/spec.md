## ADDED Requirements

### Requirement: Unified analysis tool selects plan or ad hoc execution

The conversation-agent roster SHALL expose `execute_analysis` as the sole
general analysis launch tool. Its flat object input SHALL contain `mode` plus
exactly one mode-specific field: `{ mode: "plan", planId }` or
`{ mode: "adhoc", request }`. Plan mode SHALL resolve and validate the approved
stored plan identified by `planId`; ad hoc mode SHALL construct one internal
step from `request`. Both modes SHALL return a `runId` after asynchronous launch
and SHALL leave result retrieval to the ordinary run-inspection tools.

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

- **WHEN** a call supplies neither mode-specific field, both fields, or the field belonging to the other mode
- **THEN** input validation rejects the call before routing, persistence, authorization, or launch

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

### Requirement: Utility router selects a specialist and resources

Before constructing a new ad hoc plan, the harness SHALL make one structured
call through its required utility provider/model. The call SHALL be bounded by
a 10-second deadline and SHALL receive the request, the server-loaded persisted
data-profile orientation, the plannable specialist catalog, and explicit
resource lower/default/upper bounds. It SHALL have no workspace or execution
tools. Its result MAY independently recommend a specialist id and resource
specification, but SHALL NOT change the requested execution mode, create a DAG,
or reject the request as requiring a plan.

Only an id in the plannable catalog SHALL be accepted as a routed specialist.
`scientific-executor` SHALL NOT be offered as a candidate and SHALL be used only
as the deterministic agent fallback when selection is absent, invalid, timed
out, or failed. Resource output SHALL be validated independently; absent,
malformed, or out-of-bounds resources SHALL use the ordinary default. A
resource failure SHALL NOT discard a valid agent selection, nor SHALL an agent
failure discard valid resources.

#### Scenario: Targeted request selects a specialist

- **GIVEN** the request and data profile clearly match a plannable specialist
- **WHEN** the utility call returns that specialist and valid resources
- **THEN** the internal step stores and uses both recommendations

#### Scenario: Router cannot select an agent

- **WHEN** the utility call times out, errors, returns no match, or returns an id outside the plannable catalog
- **THEN** the step uses `scientific-executor`
- **AND** the failure class or fallback rationale is recorded

#### Scenario: Invalid resources do not erase a valid route

- **GIVEN** the router returns a valid specialist and resources above the stated ceiling
- **WHEN** the result is validated
- **THEN** the specialist is retained and resources use the bounded default

#### Scenario: Router does not overrule ad hoc mode

- **GIVEN** the conversation agent called ad hoc mode with an explicit user request
- **WHEN** the utility model considers the request broad
- **THEN** it still returns or falls back to a one-step route and cannot require plan generation

### Requirement: Ad hoc resources use normal policy and scheduler enforcement

When a `ResourcePolicy` exists, routing bounds SHALL use positive CPU and memory
lower bounds no greater than their configured ceilings, the
`perStep` values as upper bounds, zero through `maxGpuCount` GPUs, and defaults
of `min(4, maxCpu)` CPU and `min(8, maxMemoryGb)` memory with no GPU. Without a
policy, the conservative bounds/default SHALL be 4 CPU, 8 GB memory, and no
GPU. The generated step SHALL carry the validated resource value, and the
ordinary snapshotted machine budget and sandbox limits SHALL enforce it exactly
as for a planned step. There SHALL be no ad hoc-specific resource
configuration.

#### Scenario: Utility estimate is within configured bounds

- **GIVEN** a policy whose per-step ceiling is 8 CPU, 16 GB, and 1 GPU
- **WHEN** the utility model recommends 2 CPU, 4 GB, and no GPU
- **THEN** the generated step carries that recommendation and the normal scheduler accounts for it

#### Scenario: Utility result has no resources

- **GIVEN** a policy whose per-step ceiling is 2 CPU and 6 GB
- **WHEN** the utility result omits resources
- **THEN** the generated step uses 2 CPU, 6 GB, and no GPU

### Requirement: Internal plan is mechanical and not an approval artifact

Ad hoc mode SHALL persist an `AnalysisPlan` with one step, no dependencies, the
request as the analytical question, the selected agent/resources, the selected
agent's ordinary iteration limit, and acceptance criteria requiring
reproducible script and result artifacts plus a direct answer. It SHALL be
constructed deterministically by harness code and SHALL NOT invoke the planner.
The plan SHALL NOT be emitted for user approval or represented as user-authored
planning intent.

The internal plan id SHALL derive from analysis and tool invocation identity.
Persistence SHALL be insert-if-absent; after any insert race, each caller SHALL
reload the stored plan so the first persisted routing decision wins.

#### Scenario: New invocation creates one-step bookkeeping

- **WHEN** an ad hoc invocation has no stored internal plan
- **THEN** the harness routes once, constructs and validates a single no-dependency step, and persists it before run reservation
- **AND** no planner model call or plan approval occurs

#### Scenario: Concurrent duplicate routing converges

- **GIVEN** two deliveries of the same invocation race before its internal plan exists
- **WHEN** both attempt insert-if-absent
- **THEN** exactly one plan row survives and both deliveries reload that same stored agent/resource decision

### Requirement: Ad hoc runs use the ordinary one-step lifecycle without synthesis

An ad hoc launch SHALL pass its internal plan through `executeAnalysis` and the
ordinary writable sandbox-step workflow. It SHALL use normal authorization,
billing, recovery, cancellation, machine-budget admission, step briefing,
summary and metadata interpretation, artifact registration, sync/indexing, run
cards, run/step ledgers, and pull-based inspection. A successful step SHALL
persist reproducible script and result files even when its answer is a single
scalar.

The workflow input SHALL set `synthesisEnabled = false`; no synthesis ledger row
or synthesis call SHALL exist for the run, and successful completion of the one
step SHALL allow the run to complete.

#### Scenario: Scalar computation remains reproducible

- **WHEN** an ad hoc step computes one numeric answer successfully
- **THEN** its writable step directory contains the script and result artifact
- **AND** the step summary and run inspection expose the answer

#### Scenario: Ad hoc run has exactly one visible step

- **WHEN** the run and step ledgers are inspected after ad hoc launch
- **THEN** they contain the one normal analysis step and no synthesis row

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
