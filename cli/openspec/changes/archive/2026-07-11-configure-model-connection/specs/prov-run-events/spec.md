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
