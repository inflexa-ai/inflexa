## Why

Change C (`embed-harness-runtime`, archived 2026-07-02) proved the embedding seam for
one workflow: the cli can stage inputs and run a real data-profile end-to-end. The
product's core verb — executing an analysis plan — still has no caller anywhere:
`executeAnalysis` is triggered only by the conversation agent's `executePlan` tool
(`harness/src/tools/execute-plan.ts`), which the cli does not run, and every remaining
change in the harness-integration program depends on it having actually run under cli
composition — the provenance bridge (change D) observes `executeAnalysis` run
boundaries and the `ArtifactRegistry` seam (`sandbox-step.ts:239`), which fires only
inside its child workflows (`docs/harness_integration-new/06-change-graph.md`). This
change is walking skeleton #2: `inflexa` runs a real multi-step analysis plan through
the embedded harness.

## What Changes

- **Composition root grows two workflow registrations**: the existing runtime boot
  (`cli/src/modules/harness/runtime.ts`) additionally registers `sandbox-step` and
  `execute-analysis` (child before parent, matching `assemble.ts`'s load-bearing
  order), keeping all registrations in one pre-launch cohort. `assembleCoreRuntime`
  stays deferred — it would force realizing conversation-agent, target-assessment,
  and ephemeral deps this change does not exercise.
- **Local realizations for the two new dep bundles**: catalog-backed `buildAgent`
  over `createSandboxAgents`, write prefix from the harness's `runStepDir` path
  convention, a real `EmbeddingProvider` instance from the existing embedding config,
  no-op `RunCharge`, and — per the change-graph sequencing — a **stub
  `ArtifactRegistry`** (registers nothing, fails nothing, no-op sync) carrying a
  `TODO(extend)` with full context: the bus-adapter provenance bridge is change D.
- **Sandbox-hygiene scheduled workflows registered at boot**: the harness ships
  `registerSandboxReaper`, `registerWatchdog`, and `registerNotificationSweep`
  (`harness/src/sandbox/`) but nothing in cli or harness calls them today. A killed
  cli mid-run orphans sandbox containers and leaves steps blocked on `DBOS.recv`
  until their deadline — these three make the in-scope kill/resume verification
  behave sanely (and retroactively cover profile runs).
- **Plan intake, a deliberately temporary dev surface**: load an analysis-plan JSON
  file from disk, validate it exactly as `executePlan` does (`AnalysisPlanSchema` +
  `validatePlan`), derive a deterministic content-hash `pln-<8hex>` id (stable id →
  re-running the same file dedups instead of double-launching), and upsert it into
  the harness's `cortex_plans`. Marked with a `TODO(extend)` block: plan authoring
  belongs to the conversation-agent/planner adoption; this surface exists so the run
  engine can be exercised before that lands, and is expected to be cleared then.
- **`inflexa run` — a new deliberate command**: resolve analysis → pre-flight →
  boot → stage inputs (reusing the staging module's mirror reconciliation) → seed
  the analysis ledger row → plan intake → trigger `executeAnalysis` via the same
  dedup → reserve → authorize → launch flow `executePlan` performs → block until a
  terminal run status with live progress (change C's command pattern), plus a
  read-only `--status` view. Warns (does not block) when no completed data profile
  exists — sandbox agents orient on `dataprofile/profile-summary.md`.
- **Additive harness edits riding along** (change C precedent): barrel exports for
  the registration functions, plan/run state functions, plan validation, sandbox
  agent catalog, and scheduled-workflow registrations; plus one additive state
  function `upsertPlan` (`insertPlan` mints its own random id and cannot take the
  caller-supplied deterministic one).
- **Kill/resume verification folded in**: the archived change C left task 6.2 (kill
  the cli mid-workflow, boot again, confirm DBOS resumes) unexecuted; this change's
  verification covers it for both the profile and run paths.

## Capabilities

### New Capabilities

- `plan-intake`: the dev-facing plan file surface — load, validate, deterministic
  id derivation, upsert into the harness plan store; explicitly temporary, cleared
  by conversation-agent/planner adoption.
- `analysis-run-launch`: the deliberate action that stages inputs and launches a
  full `executeAnalysis` run — trigger semantics (dedup/reserve/authorize/launch),
  blocking wait with progress, detach and resume behavior, status view.

### Modified Capabilities

- `harness-runtime`: the composition root's registration cohort grows from one
  workflow to three plus the scheduled sandbox-hygiene workflows; local seam
  realizations now cover `SandboxStepDeps` and `ExecuteAnalysisDeps` (including the
  stub `ArtifactRegistry` and the catalog-backed agent builder).

## Impact

- **cli**: `src/modules/harness/` gains the run command, plan intake, and the two
  dep-bundle realizations; `runtime.ts` boot extends its registration section;
  `src/cli/index.ts` registers the new command (lazy import, no passive-flow boot).
  No cli SQLite schema change; plans and runs live in the harness's Postgres tables.
- **harness**: `src/index.ts` barrel grows additively; `src/state/plans.ts` gains
  `upsertPlan`. No existing behavior changes.
- **Runtime prerequisites unchanged** from change C: sandbox image, provisioned
  Postgres, embeddings endpoint, proxy key — the same pre-flight gates apply.
- **Program sequencing**: unblocks change D (provenance bridge) with observed run
  boundaries and a live `ArtifactRegistry` call site, and change E (delete the
  custom filesystem registry) once D cuts over.
