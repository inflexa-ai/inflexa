## Why

The data-profile workflow is the one long-running piece of work in the product that reports nothing about itself. Its agent loop is driven with a discarded event sink — `emit: () => {}` in `runDataProfileBody` — so every `tool-started`, every sandbox event, and every model delta is thrown away at the point of production. A profile can occupy a user for minutes (container provisioning, then a full agent loop over their files) and the only trace it leaves is a `data_profile_status` of `'running'`.

That gap is now the binding constraint on an embedder, not a latent one. The analysis-run path just gained a live activity readout by reading the durable per-run event stream, and the same surface cannot show a profile because there is nothing to subscribe to. The profiler's tools are the ones the existing translator already maps well — `execute_command`, `read_file`, `write_file` — so the phrases an embedder wants (`Running script profile.py`, `Reading file counts.csv`) are available for the cost of wiring the sink that is currently a no-op.

A second, smaller gap makes the first unusable even once fixed: a profile's stream has no address. Its `RunFrame.runId` is the constant literal `"data-profile"`, identical for every analysis; its DBOS workflow id is `dataprofile:{analysisId}:{randomUUID()}`, where the nonce is deliberately random so that each re-profile attempt gets a distinct idempotency key; and nothing records that id. So "which stream carries this analysis's profile" is currently answerable only by pattern-matching workflow ids in the durability engine's own tables — the class of read the harness exists to keep out of an embedder's hands.

## What Changes

- The data-profile workflow body emits typed run-event parts to its own durable `"events"` stream, replacing the discarded sink. It emits `data-step-activity` at five phases with pinned phrases: `sandbox-init` before the container is created (today the longest silent stretch of a profile), `executing` when the agent starts and again on every tool call it makes, `indexing` during the vector pass, and a terminal `complete` or `failed`. The phrases are specified, not left to the implementation — they are what the user reads, and they are the one part of this work no type can check.
- The emitted parts carry the workflow's existing synthetic frame (`runId: "data-profile"`, `stepId: "profile"`) and a stable reconciling id, so a subscriber that attaches mid-profile folds to the current activity rather than replaying superseded intermediates.
- `cortex_analysis_state` gains a nullable `data_profile_workflow_id`, written by the workflow body as its first durable step and guarded on the row still being `running`. `DataProfileStatus` carries it as `workflowId`, so a consumer that already reads the ledger row learns which stream to subscribe to without touching the durability engine.
- The stable per-step part id the sandbox-step body mints — a reconciliation contract both producers must agree on — moves to the shared translation module. Nothing else about the run path's emitters changes.

Not a breaking change: the new column and the new `DataProfileStatus` field are both nullable, and a profile that predates them reads back as `null` — which a consumer treats exactly as it treats a profile that has not started emitting yet.

## Capabilities

### New Capabilities

- `data-profile-observation`: A running data profile is observable. It emits typed activity parts to its own durable event stream across its whole lifecycle, and its ledger row names the workflow producing them — so a consumer can subscribe to a profile's activity through the run-event read seam without deriving a workflow id or reading durability-engine tables.

### Modified Capabilities

- `cortex-state-layer`: the `cortex_analysis_state` table schema requirement gains the `data_profile_workflow_id` column, and the ledger's read shape gains the corresponding `workflowId` field.

`data-profile-init` and `data-profile-rerun` are deliberately **not** modified. Neither constrains observability today — no requirement in either mentions emission, streams, or activity — so the profile's event stream is a new concern layered onto them rather than a change to what they already say. Wiring the sink alters no behaviour those specs describe: the body still profiles exactly the staged manifest, still delivers through `submit_profile`, and still claims and settles the ledger the same way.

## Impact

- `src/tasks/data-profile.ts` — the emit wiring, the `sandbox-init` / `indexing` / terminal activity emissions, and the durable step that records the workflow id.
- `src/state/init.ts` — one additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, following the existing `cortex_target_assessments.workflow_id` precedent in the same DDL block.
- `src/state/data-profile.ts` — `DataProfileStatus.workflowId`, its projection in the status read, and the writer the workflow body calls.
- `src/sandbox/sandbox-step-translate.ts` — receives the lifted `stepPartId`.
- `src/workflows/sandbox-step.ts` — imports it in place of its module-private copy. This is the change's only edit to the run path, and it is behaviour-preserving by construction: the same pure function, moved.
- No change to the run-event read seam (`src/execution/run-event-stream.ts`). A profile is a workflow with no child steps, which its child-discovery loop already handles by finding none.
- **Recovery risk, recorded rather than mitigated away**: adding stream writes to an existing workflow body changes its DBOS function-id sequence, so a profile already in flight across the upgrade replays against a sequence that no longer matches. Profiles are short and the ledger's orphan-reconcile path already recovers a wedged `running` row, so the exposure is one re-profile for a profile unlucky enough to span the upgrade.
