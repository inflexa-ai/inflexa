# Proposal

## Why

GitHub issue #633. The harness change `align-run-stream-and-outputs-with-contracts`
makes `suspended_insufficient_funds` a terminal run status that does not block a
relaunch. The cli counts that status as live work, and its sidebar and its
`run --plan` message treat it as a run that waits for a resume. This companion
change aligns the cli with the harness rule.

## What Changes

- The live durable-work count of the local server counts a `running` run only.
- The sidebar treats `suspended_insufficient_funds` as a terminal status.
- The `run --plan` outcome message for a suspended run says that a new run of
  the plan can start, not that a resume comes later.
- The cli provenance bridge records the new terminal status. The harness
  change of the same name widens `ProvRunOutcome.status` in `prov-kernel`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-server`: a run counts as live work only when its ledger status is
  `running` and a live workflow stands behind it.
- `local-server`: the run stream closes when the harness run-event reader
  settles. The harness capability `run-event-stream` lists the runs that end
  with no terminal part.

## Impact

- cli code: `src/server/durable_work.ts`, `src/tui/hooks/sidebar_live.ts`,
  `src/modules/harness/dev/run.ts`, and their tests, plus the tests of
  `src/tui/hooks/run_completion.ts` and `src/server/routes/runs.ts`.
- `prov-kernel`: the cli resolves the working copy through `kernel:local`
  during development.
- The harness change of the same name carries the design and the tasks. This
  change holds the cli spec delta and the cli tasks.
