# prov-run-events — delta

## MODIFIED Requirements

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
  ProvCommandRef`, and `model: ProvModelId`. `ProvCommandRef` has one variant,
  `{ kind: "command"; command; args?; exitCode; durationMs?; scriptPath?; outputs:
  ProvFileKey[]; inputs: ProvCommandInputRef[] }`, where `ProvFileKey` is the
  `(path, hash)` pick of
  `ProvFileRef` and `ProvCommandInputRef` is `{ path, hash, source: "data" |
  "upstream" | "prior" | "step", fileId? }` — `"step"` marks a resolved intra-step
  self-read (a chain edge the step-level vocabulary never carries). The
  `kind: "command"` discriminator literal stays for wire stability. A file-tool
  write is not a command event. It rides `prov.file_written` with the `call`
  generation arm. One event per surviving producer group (last-write-wins per output
  path upstream). The payload SHALL NOT carry the producer's observation timestamp —
  it is re-minted on workflow re-execution and MUST NOT reach identifiers or formal
  positions.
- `prov.file_written` — carries `model: ProvModelId`, `file: ProvFileRef { path,
  hash, size, producer }`, and `generation: "command" | "step" | "call"` — which
  activity owns the file's generation edge. A `call` event carries
  `call: ProvCallRef { invocationId, tool, threadId? }`. A step-scoped event
  carries `step: ProvStepRef`, and a `step` generation requires it. A session
  write carries no step ref. The bridge's bucket decision rides the event so the
  recorder never infers it across events. A step-scoped
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
`src/types/events.ts`, following the one-event-per-domain-action bus rule. The bus
telemetry projection SHALL surface identifying fields for each event; for
`prov.command_executed`: runId + stepId + the command string + output
count + the model id; for `prov.step_completed`: runId + stepId + status + the
model id; for `prov.file_written`: the path + the producer + the generation arm +
the tool of a call + the model id.

#### Scenario: A command execution crosses the bus with its full facts

- **WHEN** a step's registration contains a producer group for `Rscript scripts/de.R` (exit 0) that read one data input and wrote two files
- **THEN** the bus receives one `prov.command_executed` whose `command` variant carries the command string, exit code, the script path, both outputs as `(path, hash)` keys, the command-scoped input refs, and the model that drove the step — and no observation timestamp

#### Scenario: A file-tool write is a call-generation file event, not a command

- **WHEN** an agent `write_file` produced `scripts/de.R`
- **THEN** the write crosses as `prov.file_written` with `generation: "call"`, `call: { invocationId, tool: "write_file" }`, the step ref, and the model — and no `prov.command_executed` references it

#### Scenario: The model reference never carries credentials

- **WHEN** any `prov.step_completed`, `prov.command_executed`, or `prov.file_written` event is emitted
- **THEN** its `model` carries only the configured provider slug and the resolved model id — no API key, no credentialed URL, no prompt content

### Requirement: Document builders append deterministic, PROV-valid execution records

The prov module SHALL provide six builders — `appendRunStarted`,
`appendRunCompleted`, `appendStepCompleted`, `appendCommandExecuted`,
`appendFileWritten`, `appendInputUsed` — that append W3C PROV records to an
analysis's live document. Runs, steps, command executions, and file-tool calls
SHALL be recorded as
PROV **activities**; files and used inputs as PROV **entities**:

- `appendRunStarted` / `appendRunCompleted` / `appendInputUsed`: unchanged from the
  prior revision (payload-sourced formal times; step-level used edges).
- `appendStepCompleted`: the step activity as before (payload-sourced end time,
  terminal status, `wasInformedBy` the run, `wasAssociatedWith` the actor's agent),
  PLUS the model-agent records for the event's `model` (see below) and a
  `wasAssociatedWith(stepQn, modelAgentQn)` edge.
- `appendCommandExecuted`: a command activity (`prov:type: inflexa:Command`)
  carrying the execution
  facts as attributes (`inflexa:command`, `inflexa:args`, `inflexa:exitCode`,
  `inflexa:durationMs`) and NO formal times; `wasInformedBy` the
  step activity; `wasAssociatedWith` the actor's agent AND the model agent for the
  event's `model`; a `used` edge per
  command-scoped input (including the script entity when `scriptPath` is present);
  and `wasGeneratedBy(fileQn, cmdQn)` for each output — the generation authority for
  produced files.
- `appendFileWritten`: records the file entity, `wasAttributedTo`, and
  `wasDerivedFrom(file, analysis)` as before. The generation edge follows the
  event's arm. `generation: "step"` writes `wasGeneratedBy(fileQn, stepQn)` — a
  leaf file with no producing activity. `generation: "call"` first appends a
  deterministic `inflexa:FileToolWrite` call activity, keyed on the invocation
  id and the scope (the step key, or else the thread). The call activity
  carries `inflexa:tool`, `inflexa:invocationId`, the optional
  `inflexa:threadId`, and NO formal time. It takes the actor association and
  the model-agent association. With a step ref, it is `wasInformedBy` the
  step. The call generates the file. A produced file's
  (`generation: "command"`) generation
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
collector is last-write-wins per path). The call activity QName SHALL be
deterministic from the invocation id and its scope:
`inflexa:call-{digest("{runId}|{stepId}|{invocationId}")}` with a step ref, else
`inflexa:call-{digest("{threadId}|{invocationId}")}`. An invocation id is
replay-stable, but it is unique per agent loop only. Every relation record SHALL carry a
deterministic identifier derived from its endpoint tuple, and relation records SHALL
carry NO formal time.

#### Scenario: Intra-step chains resolve through the shared entity space

- **WHEN** command A writes `output/de_results.csv` and command B (same step) reads it and writes `figures/heatmap.png`, and both groups are appended
- **THEN** the unified document contains one `de_results.csv` entity that is `wasGeneratedBy` command A's activity AND `used` by command B's activity, and `heatmap.png` is `wasGeneratedBy` command B — the chain A → file → B is walkable

#### Scenario: Exactly one generation edge per file

- **WHEN** a step registers a command-produced file, a call-written file, and one leaf file (no producer record)
- **THEN** the produced file's sole `wasGeneratedBy` references its command activity, the call-written file's references its call activity, and the leaf file's references the step activity
- **AND** no file entity carries two generation records

#### Scenario: Duplicate command emission dedups by the output-set QName

- **WHEN** the same `prov.command_executed` event is recorded twice (workflow re-execution) and the document is unified
- **THEN** the document contains one command activity under the output-set QName and one of each of its relation records — not two

#### Scenario: Duplicate call emission dedups by the invocation-scoped QName

- **WHEN** the same call-generation `prov.file_written` event is recorded twice (workflow re-execution) and the document is unified
- **THEN** the document contains one call activity under the invocation-scoped QName and one of each of its relation records — not two

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
