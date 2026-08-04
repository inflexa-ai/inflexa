# Make the two durable-workflow mechanics shareable before a third workflow needs them

## Why

Two mechanisms in the harness are written once and needed twice, and both encode
subtleties that are invisible in a fresh implementation:

**Run finalisation.** `collectAndComplete` (`src/workflows/execute-analysis.ts`)
settles every step row, sweeps never-started rows to `skipped`, writes the run's
terminal status, closes the run charge, revokes owned authorization, and emits
exactly one terminal event — each in its own named `DBOS.runStep`, none rolling
back the ones that already succeeded, with the terminal event emitted *before*
the status write so no reader can observe a terminal run without it, and with the
402 pause branch selected structurally rather than inferred from the written
status. Every clause there is a bug that was found once. A second workflow that
writes its own version does not inherit any of them.

**Durable model calls.** `runLlmStep` and `structuredLlmCall`
(`src/workflows/target-assessment/lib/`) own the per-call `DBOS.runStep` cache
slot, the forced-`submit`-tool structured-output pattern, and the
billing-gateway 402 → self-addressed marker → suspend/self-cancel choreography
that makes an insufficient-funds pause resumable. They live under
`target-assessment/` for no reason other than being written there first; nothing
in them is target-assessment-specific.

`add-manuscript-reference-review` is the second consumer of the finaliser and
`add-manuscript-editorial-review` is the second consumer of the LLM step. This
change lands both moves on their own, so a behaviour-preserving refactor of two
existing workflows is reviewed as a refactor rather than as a diff buried inside
a new feature.

## What Changes

- `runLlmStep` and `structuredLlmCall` move out of
  `src/workflows/target-assessment/lib/` into a shared workflow library, with
  their behaviour, options, and error classification unchanged.
  `executeTargetAssessment` is repointed at the new path. **Step names are
  caller-supplied**, so no DBOS cache key moves and no in-flight workflow
  changes shape mid-replay.
- The generic part of `collectAndComplete` becomes a reusable finalisation
  sequence parameterized by the caller's derived status, failure reason, and
  terminal part. `executeAnalysis` keeps `collectAndComplete` as its binding of
  that sequence: same durable step names, same ordering, same
  non-rolling-back rule, same structural selection of the 402 pause branch, and
  the analysis-specific parts (scheduler-drain results, synthesis outcome note,
  synthesis-failure forcing) stay in `executeAnalysis`.
- No behaviour changes, no new dependency, no contract change. The existing
  `executeAnalysis` and `executeTargetAssessment` suites are the acceptance
  criteria: they pass unmodified, or the extraction is wrong.

Nothing is generalized speculatively. The sequence is parameterized exactly as
far as its two known consumers require, and the manuscript-specific status
derivation stays with the workflow that derives it.

## Capabilities

### Modified Capabilities

- `workflow-failure-lifecycle`: the finalisation sequence is one shared
  implementation that every durable workflow binds, with `collectAndComplete` as
  `executeAnalysis`'s binding, preserving every guarantee the hook already makes.
- `harness-durable-runtime`: a durable workflow's model calls run through one
  shared named-step wrapper that owns the step cache slot and the 402 →
  suspend/resume choreography, rather than one copy per workflow.

## Impact

Harness source:

- `src/workflows/lib/llm-step.ts`, `src/workflows/lib/structured-llm.ts` — moved
  from `src/workflows/target-assessment/lib/`, unchanged.
- `src/workflows/lib/finalise-run.ts` — the extracted sequence.
- `src/workflows/execute-analysis.ts` — `collectAndComplete` becomes a binding of
  the shared sequence.
- `src/workflows/target-assessment/**` — import paths only.

No embedder change. No spec-visible behaviour change for either existing
workflow; the deltas record that the mechanism is now shared, which is what makes
the next two changes small.
