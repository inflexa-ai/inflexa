# prov-harness-bridge Specification

## Purpose
TBD - created by archiving change bridge-harness-provenance. Update Purpose after archive.
## Requirements
### Requirement: The artifact-registry bus adapter translates registration into provenance events

The cli SHALL provide an `ArtifactRegistry` realization (the bus adapter, in
`src/modules/harness/`) whose `register(input, session)` translates one step's
registration into bus events and nothing else. The adapter emits COMMAND, FILE, and
USED-INPUT events — step lifecycle events come from the harness's scheduler
settlement:

- **Producer grouping**: partition the reconciled manifest entries by their
  collector record's `producer` object reference (the reference implementation's
  grouping — one group per command/file-tool execution surviving last-write-wins);
  entries with NO record form the LEAF bucket. The partition is exclusive: a file is
  in exactly one group or the leaf bucket, never both.
- Per group, emit ONE `prov.command_executed` (the `command` variant with command /
  args / exitCode / durationMs / scriptPath and the group's outputs as analysis-scoped
  `(path, hash)` keys; the `file_tool` variant with the tool name and outputs),
  followed by that group's `prov.file_written` events carrying `generation:
  "command"`; leaf-bucket entries emit `prov.file_written` with `generation:
  "step"`. The producer's observation timestamp SHALL NOT be forwarded.
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
- **THEN** the bus receives two `prov.command_executed` events (one `command` variant with two outputs, one `file_tool` variant with one output), each followed by its `prov.file_written` events, and the result reports three `registered` entries

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

`ExecuteAnalysisDeps` SHALL carry an optional `emitProvenance?: (event:
RunProvenanceEvent) => void` dependency. `RunProvenanceEvent` SHALL be a
harness-owned plain union — the harness remains tsprov-free and bus-free — whose
timestamps are epoch-ms read via `DBOS.now()` (a checkpointed step, so re-executed
bodies re-emit identical values):

- `{ type: "run_started"; analysisId; runId; planSummary; stepCount; atMs }`, emitted
  at the run-started boundary (beside the `data-run-started` stream part).
- `{ type: "step_completed"; analysisId; runId; stepId; status; durationMs?; atMs }`,
  emitted at EVERY scheduler-loop settlement branch — the only site that observes
  every executed step. `status` maps the settlement outcome: `complete` →
  `"completed"`, `canceled` → `"canceled"`, `failed`/`blocked`/child-error →
  `"failed"`; `durationMs` is the child's durable result duration where present.
  Steps that were never dispatched (dependents of a failed sibling) emit nothing —
  they never executed, and the run's terminal status carries that outcome.
- `{ type: "run_completed"; analysisId; runId; status; atMs; durationMs }`, emitted
  at BOTH terminal boundaries (beside `data-run-completed` AND `data-run-failed`),
  where `status` is the body's terminal status (`RunStatus` minus `running`) and
  `durationMs = atMs − the run_started atMs`.

Call sites SHALL invoke the callback directly in the workflow body (not wrapped in a
DBOS step — body re-execution on recovery must re-fire the emission) and SHALL guard
it so a throwing observer never fails the run. When the dependency is absent the
workflow behaves exactly as before.

#### Scenario: A zero-artifact step is still recorded

- **WHEN** a step completes without producing any registrable artifact (empty reconciled manifest)
- **THEN** `emitProvenance` still receives `step_completed` with `status: "completed"` from the settlement site — the step appears in the signed document even though registration never ran

#### Scenario: Failed and canceled steps are recorded with their status

- **WHEN** one step fails and the fail-fast cascade cancels an in-flight sibling
- **THEN** `emitProvenance` receives `step_completed` with `status: "failed"` for the first and `status: "canceled"` for the sibling, while a dependent step that was never dispatched produces no event

#### Scenario: Replay re-emits identical timestamps

- **WHEN** DBOS recovery re-executes the workflow body after a host kill
- **THEN** every re-fired event carries the same `atMs`/`durationMs` values as the original emission (checkpointed clock reads), so the recorded activities merge without value conflicts

#### Scenario: Absent callback changes nothing

- **WHEN** `ExecuteAnalysisDeps` is built without `emitProvenance`
- **THEN** the workflow runs identically to the pre-change behavior

### Requirement: The cli realizes the callback as bus emission with the system actor

The cli composition SHALL realize `emitProvenance` by mapping all three harness arms
to bus events: `run_started` → `prov.run_started` (run ref with `planSummary` and
`startedAtMs`), `step_completed` → `prov.step_completed` (a `ProvStepOutcome` with
the settlement status, `completedAtMs`, and duration), and `run_completed` →
`prov.run_completed` (outcome with status, `completedAtMs`, and duration) — each
stamped with the existing system actor (cli version + commit). The mapping SHALL use
the harness-supplied `analysisId` unchanged and SHALL pass timestamps through without
re-reading any clock.

#### Scenario: Every executed step lands in the signed document

- **WHEN** `inflexa run` executes a plan where one step succeeds with artifacts, one succeeds with none, and one fails
- **THEN** the signed provenance document contains three step activities carrying statuses `completed`, `completed`, and `failed` — with true settlement times and durations

#### Scenario: A run whose host process ended is still recorded on recovery

- **WHEN** the cli process ends mid-run (detach, crash, or kill) and a later boot's DBOS recovery re-executes the workflow to a terminal status
- **THEN** the re-executed body re-fires `emitProvenance`, the recorder records the completion, and the unified document contains a single run activity whose times equal the original workflow-observed times

