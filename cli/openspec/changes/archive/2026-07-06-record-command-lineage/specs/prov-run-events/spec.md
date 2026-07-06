# prov-run-events Specification (delta)

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
  `"completed" | "failed" | "canceled"`.
- `prov.command_executed` — carries the owning `step: ProvStepRef` and `command:
  ProvCommandRef`, a discriminated union over the two execution kinds:
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

The domain types SHALL live in `src/types/prov.ts` and the events in
`src/types/events.ts`, following the one-event-per-domain-action bus rule (the
command/file-tool discriminant lives inside `ProvCommandRef` because both are one
domain action: an execution inside the step produced files). The bus telemetry
projection SHALL surface identifying fields for each event; for
`prov.command_executed`: runId + stepId + the command string or tool name + output
count.

#### Scenario: A command execution crosses the bus with its full facts

- **WHEN** a step's registration contains a producer group for `Rscript scripts/de.R` (exit 0) that read one data input and wrote two files
- **THEN** the bus receives one `prov.command_executed` whose `command` variant carries the command string, exit code, the script path, both outputs as `(path, hash)` keys, and the command-scoped input refs — and no observation timestamp

#### Scenario: File-tool writes are the second variant, not a degenerate command

- **WHEN** an agent `write_file` produced `scripts/de.R`
- **THEN** the group crosses as `ProvCommandRef { kind: "file_tool", tool: "write_file", outputs: [scripts/de.R…] }` with no inputs and no exit code

### Requirement: Document builders append deterministic, PROV-valid execution records

The prov module SHALL provide six builders — `appendRunStarted`,
`appendRunCompleted`, `appendStepCompleted`, `appendCommandExecuted`,
`appendFileWritten`, `appendInputUsed` — that append W3C PROV records to an
analysis's live document. Runs, steps, and command executions SHALL be recorded as
PROV **activities**; files and used inputs as PROV **entities**:

- `appendRunStarted` / `appendRunCompleted` / `appendStepCompleted` /
  `appendInputUsed`: unchanged from the prior revision (payload-sourced formal
  times; step-level used edges).
- `appendCommandExecuted`: a command activity (`prov:type: inflexa:Command` for the
  `command` kind, `inflexa:FileToolWrite` for `file_tool`) carrying the execution
  facts as attributes (`inflexa:command`, `inflexa:args`, `inflexa:exitCode`,
  `inflexa:durationMs` / `inflexa:tool`) and NO formal times; `wasInformedBy` the
  step activity; `wasAssociatedWith` the actor's agent; a `used` edge per
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
