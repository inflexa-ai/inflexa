# Design

## Context

See `proposal.md` for the four defects of issue #633 and the decision of the
user. These facts shape the approach:

- The parent run stream gets the synthesis parts through the `emit` sink of
  `synthesizeFindings` (`src/workflows/execute-analysis.ts:676-684`). That sink
  writes a `ChatDataPart` unchanged, thus `data-run-synthesis` keeps its
  `{ type, data }` envelope. The chat stream flattens the same envelope in
  `toChatFrame` (`src/contracts/chat-frame.ts:66-71`).
- `walkStepArtifacts` gives a path relative to the step directory
  (`src/execution/post-step.ts:48`). `inferArtifactType` tests `"/figures/"`
  and the other folders (`src/schemas/artifact-manifest.ts:34-39`). The
  metadata fallback adds a leading `/` to get around this
  (`src/execution/artifact-metadata.ts:142-144`).
- No code ever wrote `suspended_insufficient_funds` to a run row. A suspension
  writes `canceled` (`src/workflows/execute-analysis.ts:1686`,
  `src/tools/execute-analysis.ts:482`). The active set, the one-active-run
  index, and some readers still name the status as an active status.
- The run-event reader adds a terminal part only for a `canceled` row
  (`src/execution/run-event-stream.ts:287-305`). The durability engine ends a
  stream read when the workflow is no longer active. The harness never closes
  a stream itself.

## Goals / Non-Goals

**Goals:**

- One rule for a suspended run, in the code and in each spec: the run row
  reads the terminal status `suspended_insufficient_funds`.
- Each run with a run row ends its run stream with a terminal part, except in
  the cases that `run-event-stream` lists.

**Non-Goals:**

- No resume of a suspended run. The parent still ends in the engine state
  `CANCELLED`, and the pending step rows stay, as today.
- No data migration. A run that suspended before this change keeps the row
  `canceled`. A `cortex_artifacts.file_type` value that was wrong stays until
  the next registration of the same path.
- No change to cortex, Nexus, or Lumen. `tmp/claude/SESSION.md` records their
  follow-up work.
- No normalization of the nested synthesis parts that old run streams hold.

## Decisions

### D1. Flatten a data part at the run-stream sink

The synthesis sink writes each `ChatDataPart` as `{ ...data, type }`. It drops
`source`, because no run-stream part carries one. The chat stream and the run
stream use one flatten rule. Move the flatten of the `default` branch of
`toChatFrame` into one exported function of `contracts/chat-frame.ts`.
`toChatFrame` then adds the source, and the synthesis sink uses the function
as it is.

`buildRunSynthesisPart` keeps the `ChatDataPart` shape, because `EmitFn` takes
that shape. The sandbox-step sink does not change, because the only data part
that it forwards is the `data-sandbox-event` envelope. That type is outside the
part registry, and its readers expect the envelope.

Alternatives:

- A flat `buildRunSynthesisPart` with a separate sink. Rejected: it changes the
  interface of `synthesizeRun` to fix a sink defect.
- A schema check in `parseRunEventPart`. Rejected: the reader would then drop a
  bad part silently, which is the symptom of the issue. The comment of
  `parseRunEventPart` says that no part schema exists. That is false, thus the
  comment changes to give the true reason for the discriminant-only check.

### D2. Read the folder from a path segment

`inferArtifactType` matches a folder segment at the start of the path or after
a `/`, for example `(^|/)figures/`. Thus the step-relative `figures/x.png` and
the nested `output/figures/x.png` both give `figure`. The metadata fallback
passes its display path with no prefix.

As a result, each figure, script, log, and notebook gets the type of its folder.
That type reaches `data-step-output`, the artifact ledger, and the report snapshot. The
report snapshot then refuses such a file at the structural tier, as its
`FILE_TYPES_WITH_NO_CELL` rule intends.

### D3. A suspension writes a terminal run status

`deriveFinalStatus` gives `suspended_insufficient_funds` for a suspension. The
authorization refusal with the suspend flag writes the same status. The status
is terminal:

- `updateRunStatus` stamps `completed_at` for it.
- The active set is `running` only, in each run query, in the run canceler, and
  in the run-event reader. A cancel of a suspended run is `already_terminal`.
- A new migration rebuilds `idx_cortex_runs_active_plan` with the predicate
  `status = 'running'`. Its name sorts after each existing migration. It drops
  the index if it exists and makes it again. The baseline migration does not
  change, because a released migration never changes.

The harness writes the status for each suspension, whatever the reason of the
host. The harness never reads that reason (`workflow-failure-lifecycle`,
"The harness does not read the reason"). The analysis status already uses the
same literal as the one suspended state for each reason. The reason stays in
`cortex_runs.error` and in the `reason` of the `data-run-failed` part. Thus no
decision about the reasons is necessary.

These parts do not change: the charge-close outcome `{ kind: "suspended" }`, the
revoke reason `workflow-suspended`, the self-cancel to `CANCELLED`, the analysis
mark, and the skipped sweep of the pending rows. `collectAndComplete` still
selects the suspension branch from the suspension, not from the status.

The status widens these types: `ExecuteAnalysisFinalStatus` (and thus
`RunObservation.status` and the `run_completed` provenance status), the run
metric outcome, and `ProvRunOutcome.status` of `prov-kernel`.

`inspect_run` keeps the targeted state `suspended`, because it tells the agent
that the host stopped the run. That state is a terminal state: it returns at
once, and it exposes the terminal paths. List mode puts the running runs first
and each other run after them. The Run Activity lists the running runs only.

Alternative: write the status only for an insufficient-funds reason. Rejected:
the harness would then read the reason of the host.

### D4. Derive the terminal part from the run row and the workflow status

When each stream of a run ends with no `data-run-completed` or
`data-run-failed` part, the reader reads the run row. It reads a `running` row
again, up to 4 reads at 500 ms, as today. Then it maps the row:

| Row | Part |
| --- | --- |
| no row | none (a data profile, or an id that is not a run) |
| `canceled` | `data-run-failed`, `error: "Run canceled"`, `reason: "canceled"` |
| `suspended_insufficient_funds` | `data-run-failed`, `error` and `reason` from the row error |
| `failed` | `data-run-failed`, `error` from the row error |
| `completed` or `partial` | none (the body writes `data-run-completed`) |
| `running` after the last read | from the workflow status, below |

For a row that still reads `running`, the reader reads the status of the parent
workflow from the durability engine:

| Workflow status | Part |
| --- | --- |
| `CANCELLED` | `data-run-failed`, `error: "Run canceled"`, `reason: "canceled"` |
| `ERROR`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED`, `SUCCESS` | `data-run-failed`, `error: "Run ended without a terminal status"` |
| active (`PENDING`, `ENQUEUED`, `DELAYED`) | none, and a warning in the log |
| no workflow, or a failed read | none |

A row with no error gives `error: "Run failed"` or `error: "Run suspended"`,
and no `reason`. A `completed` or `partial` row gets no part.
`collectAndComplete` writes `data-run-completed` after the status write, in the
same body. Such a row with no part means that the write of the part failed.
The row holds no step counts and no findings, thus the reader cannot make a true
part. This is the one accepted gap. An active workflow means that a
stream read stopped early on a failure that the reader logged. A missing
workflow means that the launch did not start it yet, or that it never started.
In those cases a terminal part would be false.

The workflow-status read is an injected dependency, the same as
`readRunStatus`. Its default reads `DBOS.getWorkflowStatus`. Precedent: the
wedge test of `cli/src/modules/harness/dev/run.ts:635-665`.

### D5. Specs in two trees

The harness change holds the harness spec deltas, the harness code, and the
`prov-kernel` type. A companion cli change with the same name holds the delta
of `cli/openspec/specs/local-server` and the cli code. The cli spec already
lists the status as terminal in `analysis-run-launch` and in `prov-run-events`.

## Risks / Trade-offs

- [A suspended run is terminal, but its pending step rows stay `pending`] →
  The rows stay for a later resume, as `workflow-failure-lifecycle` requires.
  A reader that counts steps sees them as not started, which is true.
- [A later resume feature can meet a second run of the same plan] → The
  status does not block a relaunch, thus that feature must manage the second
  run. No resume exists today.
- [Embedders with a closed status switch get a new value] → cortex pins the
  harness and adapts when it raises the pin. `SESSION.md` records the sites.
- [The migration rebuilds an index on a live table] → The table holds one row
  for each run. The drop and the new index are in one migration.

## Migration Plan

The migrator applies the new migration at the next start of a host. A rollback
of the code leaves the narrower index, which still blocks a second `running`
row. An old binary then can start a second run of a plan while a suspended row
of that plan exists. No old binary writes the status, thus no such row exists.
