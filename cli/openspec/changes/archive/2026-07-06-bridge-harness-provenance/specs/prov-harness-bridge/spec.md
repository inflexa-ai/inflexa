# prov-harness-bridge Specification (delta)

## ADDED Requirements

### Requirement: The artifact-registry bus adapter translates registration into provenance events

The cli SHALL provide an `ArtifactRegistry` realization (the bus adapter, in
`src/modules/harness/`) whose `register(input, session)` translates one step's
registration into bus events and nothing else:

- Emit `prov.step_completed` once for `(input.runId, input.stepId)`, then
  `prov.file_written` once per manifest entry, all stamped with the system actor
  and `analysisId = input.resourceId`.
- Manifest entries arrive STEP-relative (e.g. `output/results.csv`); the adapter
  SHALL scope each to the analysis-scoped form (`runs/{runId}/{stepId}/…`) and use
  that one string for the event path, the file-QName seed, and the
  `registered[].path` write-back key — the harness matches its `cortex_artifacts`
  rows by exactly that path, and an unscoped path would both no-op the external-id
  write-back and collide same-named files across steps.
- `producer` SHALL be resolved by joining the RAW step-relative entry path against
  the collector's records (`producer.type` — the collector also keys step-relative),
  defaulting to `"command"` when no record matches (an observed sandbox write
  without an in-process producer record is a command effect).
- An entry missing its content hash SHALL be reported in `failed` (and counted in
  `failedCount`) instead of emitted — a file that cannot be content-attested is a
  registration failure, not a silently unattested PROV record. (The harness's
  reconcile step rehashes every entry from disk, so this path signals an upstream
  defect.)
- The result SHALL report each emitted entry in `registered` with the file's
  deterministic PROV QName as `externalId`, giving the harness's local ledger a
  stable cross-reference into the signed document.
- `sync()` SHALL be a local no-op — the artifact bytes already live on host disk.
- The adapter SHALL NOT write to `cortex_artifacts` or any harness-owned table (the
  seam contract); emitting bus events satisfies this by construction.

#### Scenario: One step's registration becomes step and file events

- **WHEN** `register` is called with three reconciled manifest entries for step `de-analysis` of run `run-001`
- **THEN** the bus receives one `prov.step_completed` followed by three `prov.file_written` events carrying analysis-scoped paths, hashes, sizes, and producers, and the result lists three `registered` entries whose `externalId` values are the files' PROV QNames with `failedCount: 0`

#### Scenario: Producer resolution falls back to command

- **WHEN** a manifest entry has no matching collector record for its path
- **THEN** its `prov.file_written` event carries `producer: "command"`

#### Scenario: A hash-less entry fails registration instead of degrading provenance

- **WHEN** a manifest entry arrives without a content hash
- **THEN** no `prov.file_written` is emitted for it and the result reports it in `failed` with a named error, incrementing `failedCount`

### Requirement: The harness exposes an optional run-lifecycle provenance callback

`ExecuteAnalysisDeps` SHALL gain an optional `emitProvenance?: (event:
RunProvenanceEvent) => void` dependency. `RunProvenanceEvent` SHALL be a
harness-owned plain union — the harness remains tsprov-free and bus-free:

- `{ type: "run_started"; analysisId; runId; planSummary; stepCount }`, emitted at
  the run-started boundary (beside the `data-run-started` stream part).
- `{ type: "run_completed"; analysisId; runId; status }`, emitted at BOTH terminal
  boundaries (beside `data-run-completed` AND `data-run-failed`), where `status` is
  the body's terminal status (`RunStatus` minus `running`).

Call sites SHALL invoke the callback directly in the workflow body (not wrapped in a
DBOS step — body re-execution on recovery must re-fire the emission) and SHALL guard
it so a throwing observer never fails the run. When the dependency is absent the
workflow behaves exactly as before.

#### Scenario: Terminal emission fires on the failed path too

- **WHEN** a run reaches the failed terminal boundary
- **THEN** `emitProvenance` receives `run_completed` with the failing terminal status — not only successful runs are recorded

#### Scenario: A throwing observer does not fail the run

- **WHEN** the injected `emitProvenance` throws at a boundary site
- **THEN** the run proceeds to its normal outcome and the failure is logged

#### Scenario: Absent callback changes nothing

- **WHEN** `ExecuteAnalysisDeps` is built without `emitProvenance`
- **THEN** the workflow runs identically to the pre-change behavior

### Requirement: The cli realizes the callback as bus emission with the system actor

The cli composition SHALL realize `emitProvenance` by mapping harness facts to bus
events: `run_started` → `prov.run_started` (with `planSummary` on the run ref) and
`run_completed` → `prov.run_completed` (with the terminal status), each stamped with
the existing system actor (cli version + commit). The mapping SHALL use the
harness-supplied `analysisId` unchanged — harness `resourceId` equals the cli
`analysisId` by the trigger contract, and the recorder drops unknown ids silently.

#### Scenario: Run boundaries land in the signed document

- **WHEN** `inflexa run` executes a plan to completion
- **THEN** the analysis's signed provenance document contains the run activity with start time, end time, and terminal status

#### Scenario: A run whose host process ended is still recorded on recovery

- **WHEN** the cli process ends mid-run (detach, crash, or kill) and a later boot's DBOS recovery re-executes the workflow to a terminal status
- **THEN** the re-executed body re-fires `emitProvenance`, the recorder (initialized at every cli entry) records the completion, and the unified document contains a single run activity with its terminal status — regardless of how many times recovery replays the body
