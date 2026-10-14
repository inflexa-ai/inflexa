# Spec Delta

## MODIFIED Requirements

### Requirement: The cli realizes the provenance seam as one bridge

The cli MUST realize the whole `ProvenanceSeam` in `src/modules/harness/prov_bridge.ts`. The seam constructor MUST take the live model source, thus a seam with no model is unrepresentable. The boot MUST build one seam and install it. The core bag, the run-engine deps, and the chat turn read that one installed object. The session emit maps each seam event onto its bus member. It stamps the system actor, and it carries the model that the source names at emit time. The `write-file` seam event maps onto the flattened `prov.file_written`: `generation: "call"`, the call ref with the invocation id, the tool, and the optional thread id, and NO step ref. The run emit keeps its construction-time model stamp, refreshed through the swap of the agent switch. The conversation creation emits inside the turn, through the same installed object.

The `approve-plan` event of `ProvenanceSeam` is the one exception to the system actor. It maps onto `prov.plan_approved` with the person actor of the user and no model. A person approves the plan, and no model drives the act. Its approval ref carries the thread id, the plan id, the run id, and the time of the event as `approvedAtMs`.

#### Scenario: A created report session reaches the bus

- **WHEN** the harness emits `create-session` with kind `report` and a parent thread
- **THEN** the bridge publishes `prov.session_created` with the thread id, the kind, the parent thread id, and the actor

#### Scenario: A block act carries its kind

- **WHEN** the harness emits `add-block` with the kind `figure`
- **THEN** the bridge publishes `prov.report_block_added` whose block carries the kind `figure`

#### Scenario: A conversation write maps onto the flattened file event

- **WHEN** the harness emits `write-file` with a thread id and an invocation id
- **THEN** the bridge publishes `prov.file_written` with `generation: "call"`, the call ref, the file identity with `producer: "file_tool"`, the model of the source, and no step ref

#### Scenario: A bridge defect never fails the tool

- **WHEN** the bridge throws on an emit
- **THEN** the harness guard logs the throw, and the report tool completes

#### Scenario: An approval names the person

- **WHEN** the harness emits `approve-plan` for run `r1`
- **THEN** the bridge publishes `prov.plan_approved` with the user actor, no model, and the approval ref of `r1`
