# prov-run-events Specification

## Purpose
TBD - created by archiving change bridge-harness-provenance. Update Purpose after archive.
## Requirements
### Requirement: Execution-level provenance events exist in the bus contract

The `BusEvent` union SHALL carry six execution-level provenance events, each scoped
by `analysisId` and stamped with a `ProvActor`. Timestamps in these payloads are
epoch-milliseconds observed by the harness via its checkpointed clock — replay-stable
by construction, never minted by the cli recorder:

- `prov.run_started` — carries `run: ProvRunRef { runId, planSummary?, startedAtMs }`.
- `prov.run_completed` — carries `outcome: ProvRunOutcome { runId, status,
  completedAtMs, durationMs? }` where `status` is the harness's terminal run
  vocabulary: `"completed" | "partial" | "failed" | "canceled" |
  "suspended_insufficient_funds"`.
- `prov.step_completed` — carries `outcome: ProvStepOutcome { runId, stepId, status,
  completedAtMs, durationMs? }` where `status` is the step-settlement vocabulary
  `"completed" | "failed" | "canceled"`, and `model: ProvModelId` — the LLM that
  drove the step.
- `prov.command_executed` — carries the owning `step: ProvStepRef`, `command:
  ProvCommandRef`, and `model: ProvModelId`. `ProvCommandRef` is a discriminated
  union over the two execution kinds:
  `{ kind: "command"; command; args?; exitCode; durationMs?; scriptPath?; outputs:
  ProvFileKey[]; inputs: ProvCommandInputRef[] }` or `{ kind: "file_tool"; tool;
  outputs: ProvFileKey[] }`, where `ProvFileKey` is the `(path, hash)` pick of
  `ProvFileRef` and `ProvCommandInputRef` is `{ path, hash, source: "data" |
  "upstream" | "prior" | "step", fileId? }` — `"step"` marks a resolved intra-step
  self-read (a chain edge the step-level vocabulary never carries). One event per surviving producer group (last-write-wins per output
  path upstream). The payload SHALL NOT carry the producer's observation timestamp —
  it is re-minted on workflow re-execution and MUST NOT reach identifiers or formal
  positions.
- `prov.file_written` — carries `file: ProvFileRef { path, hash, size, producer }`,
  the producing `step: ProvStepRef`, and `generation: "command" | "step"` — which
  activity owns the file's generation edge. The bridge's bucket decision (producer
  group vs leaf) rides the event so the recorder never infers it across events.
  `path` SHALL be analysis-scoped (`runs/{runId}/{stepId}/…`).
- `prov.input_used` — carries the reading `step: ProvStepRef` and `input:
  ProvUsedInputRef { path, hash, source, fileId? }` with `source ∈ "data" |
  "upstream" | "prior"` — the STEP-level attested-inputs registry, unchanged by the
  command-level edges (deliberate redundancy; see the builders requirement).

`ProvModelId` SHALL be the vendor-qualified `{provider}/{model}` name (the
convention model ecosystems use — e.g. `anthropic/claude-opus-4-8`,
`openai/gpt-5`), enforced as a template-literal string type. The model part is
the RESOLVED id (never a config `null`); the provider part is the model
connection's CONFIGURED provider slug (see `model-connection`) — an OPEN
vocabulary with no closed union to keep in step with any provider list, and
never derived from the model id: an unattestable provider is a configuration
error surfaced at boot, not a recorded guess. The payload SHALL
NOT carry API keys, credentialed URLs, or prompt content.

The domain types SHALL live in `src/types/prov.ts` and the events in
`src/types/events.ts`, following the one-event-per-domain-action bus rule (the
command/file-tool discriminant lives inside `ProvCommandRef` because both are one
domain action: an execution inside the step produced files). The bus telemetry
projection SHALL surface identifying fields for each event; for
`prov.command_executed`: runId + stepId + the command string or tool name + output
count + the model id; for `prov.step_completed`: runId + stepId + status + the
model id.

#### Scenario: A command execution crosses the bus with its full facts

- **WHEN** a step's registration contains a producer group for `Rscript scripts/de.R` (exit 0) that read one data input and wrote two files
- **THEN** the bus receives one `prov.command_executed` whose `command` variant carries the command string, exit code, the script path, both outputs as `(path, hash)` keys, the command-scoped input refs, and the model that drove the step — and no observation timestamp

#### Scenario: File-tool writes are the second variant, not a degenerate command

- **WHEN** an agent `write_file` produced `scripts/de.R`
- **THEN** the group crosses as `ProvCommandRef { kind: "file_tool", tool: "write_file", outputs: [scripts/de.R…] }` with no inputs and no exit code

#### Scenario: The model reference never carries credentials

- **WHEN** any `prov.step_completed` or `prov.command_executed` event is emitted
- **THEN** its `model` carries only the configured provider slug and the resolved model id — no API key, no credentialed URL, no prompt content

### Requirement: Document builders append deterministic, PROV-valid execution records

The prov module SHALL provide six builders — `appendRunStarted`,
`appendRunCompleted`, `appendStepCompleted`, `appendCommandExecuted`,
`appendFileWritten`, `appendInputUsed` — that append W3C PROV records to an
analysis's live document. Runs, steps, and command executions SHALL be recorded as
PROV **activities**; files and used inputs as PROV **entities**:

- `appendRunStarted` / `appendRunCompleted` / `appendInputUsed`: unchanged from the
  prior revision (payload-sourced formal times; step-level used edges).
- `appendStepCompleted`: the step activity as before (payload-sourced end time,
  terminal status, `wasInformedBy` the run, `wasAssociatedWith` the actor's agent),
  PLUS the model-agent records for the event's `model` (see below) and a
  `wasAssociatedWith(stepQn, modelAgentQn)` edge.
- `appendCommandExecuted`: a command activity (`prov:type: inflexa:Command` for the
  `command` kind, `inflexa:FileToolWrite` for `file_tool`) carrying the execution
  facts as attributes (`inflexa:command`, `inflexa:args`, `inflexa:exitCode`,
  `inflexa:durationMs` / `inflexa:tool`) and NO formal times; `wasInformedBy` the
  step activity; `wasAssociatedWith` the actor's agent AND the model agent for the
  event's `model`; a `used` edge per
  command-scoped input (including the script entity when `scriptPath` is present);
  and `wasGeneratedBy(fileQn, cmdQn)` for each output — the generation authority for
  produced files.
- `appendFileWritten`: records the file entity, `wasAttributedTo`, and
  `wasDerivedFrom(file, analysis)` as before, but SHALL write its step-level
  `wasGeneratedBy(fileQn, stepQn)` ONLY when the event carries `generation:
  "step"` — leaf files with no producing command activity (e.g. inotify-only
  observations). A produced file's generation
  comes exclusively from `appendCommandExecuted`; exactly one generation edge SHALL
  exist per file entity.

The model-agent records: one PROV agent per distinct `{provider}/{model}` name
under the deterministic QName `inflexa:agent-model-{digest(name)}`, typed BOTH
`prov:SoftwareAgent` and `inflexa:Model`, carrying the qualified name as its ONLY
identity attribute (`inflexa:model`, plus `prov:label`) — the provider lives
inside the name, never as a separate closed attribute; plus one
`actedOnBehalfOf(modelAgentQn, responsibleAgentQn)` delegation — the
model acted on behalf of the event's responsible agent (the CLI the user directed) —
under a deterministic id derived from both agent digests. Model-agent
`wasAssociatedWith` edges SHALL reuse the existing association id templates,
disambiguated by the agent digest, so the CLI-agent and model-agent associations on
one activity coexist and re-emission dedups.

The command activity QName SHALL be deterministic from the group's OUTPUT SET —
`inflexa:cmd-{runId}-{stepId}-{digest(sorted output (path, hash) pairs)}` — never
from producer object identity or observation timestamps (both vary across workflow
re-execution, while the surviving output set is replay-stable because the upstream
collector is last-write-wins per path). Every relation record SHALL carry a
deterministic identifier derived from its endpoint tuple, and relation records SHALL
carry NO formal time.

#### Scenario: Intra-step chains resolve through the shared entity space

- **WHEN** command A writes `output/de_results.csv` and command B (same step) reads it and writes `figures/heatmap.png`, and both groups are appended
- **THEN** the unified document contains one `de_results.csv` entity that is `wasGeneratedBy` command A's activity AND `used` by command B's activity, and `heatmap.png` is `wasGeneratedBy` command B — the chain A → file → B is walkable

#### Scenario: Exactly one generation edge per file

- **WHEN** a step registers two produced files (in command groups) and one leaf file (no producer record)
- **THEN** each produced file's sole `wasGeneratedBy` references its command activity, the leaf file's sole `wasGeneratedBy` references the step activity, and no file entity carries two generation records

#### Scenario: Duplicate command emission dedups by the output-set QName

- **WHEN** the same `prov.command_executed` event is recorded twice (workflow re-execution) and the document is unified
- **THEN** the document contains one command activity under the output-set QName and one of each of its relation records — not two

#### Scenario: A step activity is associated with both the CLI and the model

- **WHEN** a `prov.step_completed` carrying `model: "anthropic/claude-sonnet-4-5"` is recorded and the document is unified
- **THEN** the step activity has two `wasAssociatedWith` edges — one to `inflexa:agent-system` and one to the model agent — and the model agent is typed `prov:SoftwareAgent` + `inflexa:Model`, carries `inflexa:model`, and `actedOnBehalfOf` the system agent

#### Scenario: One agent per distinct model, shared across steps and commands

- **WHEN** two steps and one command execution driven by the same model id are recorded and the document is unified
- **THEN** the document contains exactly ONE model agent under the deterministic QName, one delegation record, and three model associations (one per activity)

#### Scenario: The qualified name is the whole identity — no separate provider attribute

- **WHEN** a step driven by `anthropic/claude-opus-4-8` is recorded
- **THEN** its model agent carries `inflexa:model: "anthropic/claude-opus-4-8"` as its only identity attribute — the provider is inside the name, and no `inflexa:provider` attribute exists

#### Scenario: Duplicate model-agent emission dedups

- **WHEN** the same `prov.step_completed` (same model ref) is recorded twice (workflow re-execution) and the document is unified
- **THEN** the document contains one model agent, one delegation record, and one model association for the step — not two

### Requirement: Replay-idempotent recording

Recording SHALL be replay-idempotent: re-emitting an execution-level event (as DBOS
workflow re-execution does on recovery) MUST NOT structurally duplicate PROV
records — after `unified()`, the document SHALL contain one record set per
deterministic identifier (elements AND relations) regardless of how many times the
same event was recorded. Additionally, a conflicting single-valued formal attribute
MUST NOT prevent persistence: the cli's `unified()` invocations on the persistence
and export paths SHALL pass tsprov's `formalAttributeConflict: "first"` policy, so a
value conflict degrades to keep-first-plus-log instead of an unfushable analysis.

#### Scenario: Duplicate emission dedups by deterministic identifier

- **WHEN** the same `prov.run_started` and `prov.step_completed` events are emitted twice and the document is flushed and unified
- **THEN** the serialized document contains one run activity, one step activity, and ONE of each relation record — not two

#### Scenario: A formal-time conflict cannot poison the flush

- **WHEN** the live document somehow holds two same-QName activity records whose formal times differ (a defect upstream of the builders' determinism)
- **THEN** the flush still unifies, signs, and persists — the first-recorded time survives and the conflict is logged — rather than throwing on every retry and leaving the analysis permanently unfushable

### Requirement: Execution events flow through the existing recorder and signing path

The provenance recorder SHALL handle the four execution events exactly as the
analysis-lifecycle events: load-or-create the live document for `event.analysisId`,
append via the matching builder, mark dirty, and debounce-flush through the
unchanged chain-hash + Ed25519 signing path. Events whose `analysisId` has no
analysis row SHALL be dropped (the existing recorder guard). Signing failure SHALL
crash the flush — provenance is never degraded to unsigned.

#### Scenario: Bus emission lands in the signed column

- **WHEN** `prov.run_started`, `prov.step_completed`, and `prov.file_written` are emitted for a known analysis and the recorder flushes
- **THEN** `analyses.provenance` holds a PROV-JSON document containing the run, step, and file records, with the chain hash and signature updated

#### Scenario: Unknown analysis is dropped silently

- **WHEN** an execution event references an `analysisId` with no analysis row
- **THEN** the recorder ignores the event and no document is created or modified

