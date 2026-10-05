# prov-harness-bridge — delta

## MODIFIED Requirements

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
