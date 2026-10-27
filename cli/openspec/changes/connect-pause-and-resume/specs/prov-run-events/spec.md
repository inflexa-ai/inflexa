## MODIFIED Requirements

### Requirement: Execution-level provenance events exist in the bus contract

The `BusEvent` union SHALL carry six execution-level provenance events, each scoped
by `analysisId` and stamped with a `ProvActor`. Timestamps in these payloads are
epoch-milliseconds observed by the harness, never minted by the cli recorder. A
workflow body reads its checkpointed clock, thus a replay gives the same values. The
run canceler reads the wall clock one time for the end events of a run that it
cancels, because no replay fires them again:

- `prov.run_started` — carries `run: ProvRunRef { runId, planSummary?, startedAtMs }`.
- `prov.run_completed` — carries `outcome: ProvRunOutcome { runId, status,
  completedAtMs, durationMs? }` where `status` is the harness's terminal run
  vocabulary: `"completed" | "partial" | "failed" | "canceled"`.
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
