# prov-harness-bridge Specification

## Purpose
TBD - created by archiving change bridge-harness-provenance. Update Purpose after archive.
## Requirements
### Requirement: The artifact-registry bus adapter translates registration into provenance events

The cli SHALL provide an `ArtifactRegistry` realization (the bus adapter, in
`src/modules/harness/`) constructed with the `ProvModelId` of the model driving the
step seat, whose `register(input, session)` translates one step's
registration into bus events and nothing else. The adapter emits COMMAND, FILE, and
USED-INPUT events — step lifecycle events come from the harness's scheduler
settlement:

- **Producer grouping**: partition the reconciled manifest entries by their
  collector record's `producer` object reference (the reference implementation's
  grouping — one group per command/file-tool execution surviving last-write-wins);
  entries with NO record form the LEAF bucket. The partition is exclusive: a file is
  in exactly one group or the leaf bucket, never both.
- Per COMMAND group, emit ONE `prov.command_executed` (the `command` variant with
  command / args / exitCode / durationMs / scriptPath and the group's outputs as
  analysis-scoped `(path, hash)` keys),
  stamped with the construction-time model id. Then emit
  that group's `prov.file_written` events, with `generation:
  "command"`, the model id, and the step ref. Per FILE-TOOL group, emit
  `prov.file_written` with `generation: "call"`,
  `call: { invocationId, tool }` from the collector record's producer, the model
  id, and the step ref — and NO command event: the recorder mints the
  deterministic call activity from the event. Leaf-bucket entries emit
  `prov.file_written` with `generation: "step"`, the model id, and the step ref.
  The producer's observation timestamp SHALL NOT be forwarded.
- **Command-scoped inputs**: the group's `inputs` are its record's per-command reads
  with `source ∈ "data" | "upstream" | "prior"` passed through (container paths
  stripped to analysis-relative), and `source: "artifacts"` reads — the step's own
  prior outputs — RESOLVED to their analysis-scoped `runs/{runId}/{stepId}/…` form
  and included ONLY when that path is present in the reconciled manifest (a read of
  a written-then-deleted phantom is dropped: its entity was never registered and the
  edge would dangle). This is what makes intra-step chains representable at command
  scope while the step-level registry continues to skip `"artifacts"` reads.
- Manifest entries arrive STEP-relative; the adapter SHALL scope paths to the
  analysis-scoped form for events, QName seeds, and the `registered[].path`
  write-back key, as before.
- Emit `prov.input_used` once per tracked input ref (skip `source: "artifacts"`),
  and report hash-less entries or refs in `failed` — both unchanged from the prior
  revision.
- The result SHALL report each emitted entry in `registered` with the file's
  deterministic PROV QName as `externalId`; `sync()` SHALL be a local no-op; the
  adapter SHALL NOT write to `cortex_artifacts` or any harness-owned table and SHALL
  NOT emit `prov.step_completed`.

#### Scenario: Registration emits command groups before their files

- **WHEN** `register` is called with three manifest entries where two share one command's producer record and one was written by a file tool
- **THEN** the bus receives one `prov.command_executed` (with two outputs), then its two `prov.file_written` events, then one call-generation `prov.file_written` for the file-tool write
- **AND** the result reports three `registered` entries

#### Scenario: A file-tool write carries its call ref and no command event

- **WHEN** a manifest entry's collector record holds a `file_tool` producer with an invocation id
- **THEN** its `prov.file_written` carries `generation: "call"`, `call: { invocationId, tool }`, the step ref, and the model id, and no `prov.command_executed` references it

#### Scenario: A leaf entry emits no command event

- **WHEN** a manifest entry has no collector record for its path
- **THEN** no `prov.command_executed` references it and its `prov.file_written` carries `producer: "command"` (the existing inotify-only fallback) — its generation edge falls to the step activity in the document

#### Scenario: An intra-step read becomes a command-scoped input

- **WHEN** a command's record contains an `"artifacts"`-source read of a path that another group in the same registration produced
- **THEN** that command's `prov.command_executed` lists the read among `inputs` in its analysis-scoped form with `source: "step"`, while the step-level `prov.input_used` events still skip it

#### Scenario: A phantom self-read is dropped, not dangled

- **WHEN** a command's record contains an `"artifacts"`-source read of a path absent from the reconciled manifest (written then deleted)
- **THEN** the read appears in no event — no `used` edge references an unregistered entity

### Requirement: The harness exposes an optional run-lifecycle provenance callback

The harness MUST carry the run emit as the `emitRunEvent` member of its `ProvenanceSeam`, with the signature `(event: RunProvenanceEvent, session: RunSession) => void`. An implementation can ignore the session parameter, thus a realization that reads only the event stays correct. `RunProvenanceEvent` MUST be a harness-owned plain union, with no tsprov import and no bus import in the harness API. The harness uses tsprov only as a report page asset, as bytes, and a harness lint rule MUST ban every tsprov API import. The other seam shapes, `SessionProvenanceEvent` and `ProvenanceExport`, obey the same plain-shape rule. Timestamps are epoch-ms read with `DBOS.now()`, a checkpointed step, thus a re-executed body emits identical values:

- `{ type: "run_started"; analysisId; runId; planSummary; stepCount; atMs }`, emitted at the run-started boundary, beside the `data-run-started` stream part.
- `{ type: "step_completed"; analysisId; runId; stepId; status; durationMs?; atMs }`, emitted at EVERY scheduler-loop settlement branch — the only site that observes every executed step. `status` maps the settlement outcome: `complete` → `"completed"`, `canceled` → `"canceled"`, and `failed`, `blocked`, or a child error → `"failed"`. `durationMs` is the durable result duration of the child where present. A step that was never dispatched, as the dependent of a failed sibling, emits nothing. It never executed, and the terminal status of the run carries that outcome.
- `{ type: "run_completed"; analysisId; runId; status; atMs; durationMs }`, emitted at BOTH terminal boundaries, beside `data-run-completed` AND `data-run-failed`. `status` is the terminal status of the body, `RunStatus` minus `running`, and `durationMs = atMs − the run_started atMs`.

Call sites MUST invoke the member directly in the workflow body, never inside a DBOS step. Body re-execution on recovery must fire the emission again. Call sites MUST guard it, thus a throwing observer never fails the run. When the member is absent, the workflow behaves exactly as before.

#### Scenario: A zero-artifact step is still recorded

- **WHEN** a step completes without producing any registrable artifact (empty reconciled manifest)
- **THEN** the run emit still receives `step_completed` with `status: "completed"` from the settlement site — the step appears in the signed document although registration never ran

#### Scenario: Failed and canceled steps are recorded with their status

- **WHEN** one step fails and the fail-fast cascade cancels an in-flight sibling
- **THEN** the run emit receives `step_completed` with `status: "failed"` for the first and `status: "canceled"` for the sibling. A dependent step that was never dispatched produces no event

#### Scenario: Replay re-emits identical timestamps

- **WHEN** DBOS recovery re-executes the workflow body after a host kill
- **THEN** every re-fired event carries the same `atMs` and `durationMs` values as the original emission, thus the recorded activities merge without value conflicts

#### Scenario: Absent member changes nothing

- **WHEN** the composition binds no run emit member
- **THEN** the workflow runs identically to the pre-change behavior

### Requirement: The cli realizes the callback as bus emission with the system actor

The cli composition MUST realize the run emit member by mapping all three harness
arms to bus events: `run_started` → `prov.run_started` (run ref with `planSummary` and
`startedAtMs`), `step_completed` → `prov.step_completed` (a `ProvStepOutcome` with
the settlement status, `completedAtMs`, and duration, stamped with the
construction-time `ProvModelId` of the model driving the step seat), and
`run_completed` → `prov.run_completed` (outcome with status, `completedAtMs`, and
duration) — each
stamped with the existing system actor (cli version + commit). The realization SHALL
be constructed with the `{provider}/{model}` name composed at boot from two
CONFIGURED facts: the model connection's `provider` slug (see `model-connection` —
setup-recorded in `cliproxy` mode, user-stated in `direct` mode) and the RESOLVED
model id (the config override, or the cliproxy auto-resolution when the config is
`null`) — never a config `null`, never a credential, and never a provider derived
from the model id. The mapping SHALL use
the harness-supplied `analysisId` unchanged and SHALL pass timestamps through without
re-reading any clock.

#### Scenario: Every executed step lands in the signed document

- **WHEN** `inflexa run` executes a plan where one step succeeds with artifacts, one succeeds with none, and one fails
- **THEN** the signed provenance document contains three step activities carrying statuses `completed`, `completed`, and `failed` — with true settlement times and durations, each associated with the model agent of the boot-resolved model

#### Scenario: A run whose host process ended is still recorded on recovery

- **WHEN** the cli process ends mid-run (detach, crash, or kill) and a later boot's DBOS recovery re-executes the workflow to a terminal status
- **THEN** the re-executed body re-fires `emitProvenance`, the recorder records the completion, and the unified document contains a single run activity whose times equal the original workflow-observed times

#### Scenario: An auto-resolved default model is recorded under the configured provider

- **WHEN** the connection is cliproxy mode with a setup-recorded provider and `harness.model` is unset, and boot auto-resolves the proxy's default model id
- **THEN** the step events carry `{configured provider}/{resolved id}` in `model` — never `null`, a placeholder, or a family-derived slug

#### Scenario: A direct connection is recorded with its stated provider

- **WHEN** the connection is `{ mode: "direct", provider: "deepseek", … }` and the configured model is `some-alias-v2`
- **THEN** the step events carry `deepseek/some-alias-v2` — the configured facts verbatim; no `unknown/` fallback exists

### Requirement: The cli realizes the provenance seam as one bridge

The cli MUST realize the whole `ProvenanceSeam` in `src/modules/harness/prov_bridge.ts`. The seam constructor MUST take the live model source, thus a seam with no model is unrepresentable. The boot MUST build one seam and install it. The core bag, the run-engine deps, and the chat turn read that one installed object. The session emit maps each seam event onto its bus member. It stamps the system actor, and it carries the model that the source names at emit time. The `write-file` seam event maps onto the flattened `prov.file_written`: `generation: "call"`, the call ref with the invocation id, the tool, and the optional thread id, and NO step ref. The run emit keeps its construction-time model stamp, refreshed through the swap of the agent switch. The conversation creation emits inside the turn, through the same installed object.

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

### Requirement: The cli realizes the document read

The cli MUST realize the read member of the seam. The realization drains the provenance flush, reads the stored document bytes, and builds a fresh attestation over them. The stored bytes are the exact signed bytes, thus the attestation matches the document. An analysis with no stored document gives absence, in-band, and the realization MUST NOT treat absence as an error. When the attestation build fails, the realization MUST give absence, and it MUST log the failure. A document without its proof never reaches a page.

#### Scenario: A populated analysis gives both strings

- **WHEN** the preview asks the read for an analysis with a stored document
- **THEN** the read gives the stored document bytes and a matching attestation string

#### Scenario: No document gives absence

- **WHEN** the preview asks the read for an analysis whose provenance column is null
- **THEN** the read gives absence, and the page renders with no provenance assets

#### Scenario: A failed attestation gives absence

- **WHEN** the key file does not load and the attestation build fails
- **THEN** the read gives absence, the failure is logged, and the page renders with no provenance assets

#### Scenario: The drain closes the debounce race

- **WHEN** a report act lands and the preview reads the seam before the debounced flush fires
- **THEN** the drain runs first, and the read gives the bytes that include the act
