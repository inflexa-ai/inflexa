# Proposal

## Why

GitHub issue #633: the run stream and the run outputs disagree with their
contracts. A client that parses the run stream with `RunSynthesisPartSchema`
drops the synthesis. A top-level figure, script, log, or notebook of a step is
typed `output`. The specs give two rules for a suspended run, and readers wait
for a run status that no code writes. The run stream can close with no terminal
part, although the cli `local-server` spec says that it closes after the
terminal part.

The user decided that a suspended run records the run status
`suspended_insufficient_funds`. A host can then tell from the status alone that
a run stopped because the host suspended it, and not because a person canceled
it.

## What Changes

- The synthesis sink of the parent run stream writes each data part flat,
  `{ ...data, type }`, the same as the chat stream. Thus `data-run-synthesis`
  has the shape of `RunSynthesisPart`.
- `inferArtifactType` reads a folder segment at the start of the step-relative
  path or after a `/`. Thus `figures/x.png` is a `figure`. The leading-slash
  workaround of the metadata fallback goes away.
- **BREAKING** A suspension writes the run status `suspended_insufficient_funds`
  instead of `canceled`. The status is terminal: it stamps `completed_at`, and
  it does not block a relaunch of the plan. This applies to each suspension: a
  suspended step, a suspended synthesis, a charge-open refusal with the suspend
  flag, and a run-authorization refusal with the suspend flag.
- **BREAKING** The active run set is `running` only. A new migration rebuilds
  `idx_cortex_runs_active_plan` with the predicate `status = 'running'`. The
  run queries, the run canceler, `inspect_run`, the Run Activity, and the
  run-event reader use the same set.
- **BREAKING** `ExecuteAnalysisFinalStatus`, `RunObservation.status`, the
  `run_completed` provenance status, and the run metric outcome gain
  `suspended_insufficient_funds`.
- When the streams of a run end with no terminal part, the run-event
  subscription adds one. It derives the part from the run row, and from the
  workflow status of the durability engine when the row still reads `running`.
  The `run-event-stream` delta lists the cases that get no part: no run row, a
  `completed` or `partial` row, a live workflow, and no workflow.
- The cli and `prov-kernel` adapt to the harness: the cli live-work count, the
  sidebar terminal map, the `run --plan` message, and the `ProvRunOutcome`
  status type. A companion cli change carries the cli spec delta.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-failure-lifecycle`: a suspension writes the terminal run status
  `suspended_insufficient_funds`, which does not block a relaunch. The
  contradicting text about a suspended run that stays active goes away.
- `run-state-persistence`: the one-active-run index and the active set hold
  `running` only, and `updateRunStatus` treats `suspended_insufficient_funds` as
  terminal. The stale text about the readers of `cortex_artifacts.file_type` is
  corrected.
- `run-inspection`: a suspended run is terminal history in list mode, and its
  targeted state exposes the terminal paths.
- `conversation-run-awareness`: the Run Activity lists the running runs only.
- `run-event-stream`: each run with a run row ends with a terminal part,
  except in the cases that the delta lists, and a data part rides the run
  stream flat.
- `run-cancellation`: a cancel of a `suspended_insufficient_funds` run is
  `already_terminal`.
- `artifact-manifest`: the type comes from a folder segment at any position of
  the step-relative path, the first segment included.

## Impact

- Harness code: `workflows/execute-analysis.ts`, `tools/execute-analysis.ts`,
  `state/runs.ts`, a new file in `state/migrations/`, `execution/run-canceler.ts`,
  `execution/run-event-stream.ts`, `execution/run-event-parts.ts`,
  `contracts/chat-frame.ts`, `schemas/artifact-manifest.ts`,
  `execution/artifact-metadata.ts`, `tools/research/inspect-run.ts`,
  `app/run-activity.ts`, `provenance/seam.ts`, `lib/metrics.ts`, and their tests.
- cli code: `src/server/durable_work.ts`, `src/tui/hooks/sidebar_live.ts`,
  `src/modules/harness/dev/run.ts`, and their tests, plus the tests of
  `src/tui/hooks/run_completion.ts` and `src/server/routes/runs.ts`.
- `prov-kernel`: `src/types.ts` (`ProvRunOutcome.status`).
- Database: one migration that rebuilds one partial-unique index. No data
  migration. A run that suspended before this change keeps the row `canceled`.
- Embedders: cortex pins the harness version. When cortex raises the pin, it
  must adapt its resume gate, its status route, its client status type, and its
  run-stream poll. That work is outside this repository.
