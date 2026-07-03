## Context

Change C left a working embedded runtime that registers exactly one workflow
(`registerDataProfileWorkflow`, `cli/src/modules/harness/runtime.ts:270`) and a
command pattern (pre-flight → boot → stage → trigger → block-to-terminal → status)
proven by live E2E. This change extends the same composition root to the run engine.

Verified facts the design rests on (all read against the current tree, 2026-07-03):

- **The trigger flow lives in a chat tool.** `executePlan`
  (`harness/src/tools/execute-plan.ts`) is the only `executeAnalysis` caller. Its
  flow: `loadPlan` → `AnalysisPlanSchema.safeParse` → `validatePlan` → dedup
  pre-check (`queryActiveRun`) → reserve (`insertRun`, partial-unique index +
  `RunDedupCollisionError` as the race backstop) → `runAuthorizer.authorize` →
  build `ExecuteAnalysisInput` (per-step prompt/agent/resources/timeout maps via
  `renderStepPrompt`) → `runLauncher.launch(executeAnalysisWorkflow, {workflowId:
  runId}, input)`, with failure paths that mark the row failed and revoke.
- **Registration order is load-bearing and `registerAnalysisWorkflows` is unusable
  by an embedder.** `assemble.ts:75-76` registers the child first because the
  parent's deps close over the registered child callable
  (`ExecuteAnalysisDeps.sandboxStepCallable`). `registerAnalysisWorkflows`
  (`register-workflows.ts:44-49`) instead takes a fully-formed
  `ExecuteAnalysisDeps` — which cannot exist before the child is registered, and
  registering the child yourself first would make its own `registerSandboxStep`
  call a double-registration violation. Flag upstream; do not use.
- **`SandboxStepDeps.buildAgent` has no production realization anywhere** — the
  embedder must supply it. The in-repo reference is data-profile's own agent
  construction (`tasks/data-profile.ts:207-235`): build `SandboxAgentDeps` from
  composition-level deps + per-step coords, then call the per-agent factory. The
  catalog exposes `createSandboxAgents(deps)` → `Record<agentId, AgentDefinition>`
  (`agents/sandbox/index.ts`), keyed by the same agent ids `validatePlan` checks
  (`KNOWN_AGENT_IDS`).
- **The stub registry is contract-honest.** The post-step pipeline fails a step
  only when `failedCount > 0` (`execution/post-step-pipeline.ts:162-172`);
  `registered: []` merely skips external-id write-back. `ArtifactRegistry.register`
  implementations MUST NOT touch `cortex_artifacts` (`artifact-registry.ts:69-71`)
  — a no-op satisfies this by construction.
- **The three sandbox-hygiene scheduled workflows have zero callers.**
  `registerSandboxReaper` / `registerWatchdog` / `registerNotificationSweep`
  (`sandbox/reaper.ts:147`, `watchdog.ts:169`, `notification-sweep.ts:84`) are
  exported registration functions nothing invokes — in cli or harness. Without the
  watchdog, a dead sandbox leaves its step blocked on `DBOS.recv` until the step
  deadline; without the reaper, a killed host orphans containers.
- **`executeAnalysis` does not materialize inputs.** Its docstring says
  "materialize input data from the managed root" (`execute-analysis.ts:10`) but
  `validateAndInit` only mkdirs the run dir and opens the charge — the body assumes
  the session tree is populated. The cli must stage inputs before triggering, same
  as profile. (Stale docstring — flag upstream.)
- **`ChatProvider extends AgentChat`** (`providers/types.ts:40-45`) — the existing
  proxy-backed provider satisfies `SandboxStepDeps.provider` unchanged. Both new
  dep bundles want an `EmbeddingProvider` *instance* (unlike `DataProfileDeps`'
  config shape); `createEmbeddingProvider` is already barrel-exported
  (`index.ts:68`) and data-profile constructs one from the same config internally.
- **`insertPlan` mints its own id** (`pln-${randomUUID().slice(0,8)}`,
  `state/plans.ts:30`) and offers no caller-supplied-id path; `loadPlan` is
  analysis-scoped. `cortex_runs` dedup is keyed `(analysisId, planId)`
  (`queryActiveRun`), so a fresh random plan id per invocation would defeat dedup
  and double-launch on re-run.

## Goals / Non-Goals

**Goals:**

- `inflexa` executes a real multi-step analysis plan end-to-end: staged inputs,
  parent + child DBOS workflows, real sandboxes per step, post-step pipeline
  (metadata, summaries, registration through the stub seam, vector indexing),
  run-level synthesis, terminal status in `cortex_runs`.
- Every `SandboxStepDeps` / `ExecuteAnalysisDeps` seam has a named, deliberate
  local realization; the two temporary ones (plan intake, stub registry) carry
  `TODO(extend)` blocks with enough context to clear them later.
- Kill/resume verified: a cli killed mid-run resumes the run on next boot
  (covers archived change C's unexecuted task 6.2 for profile too).

**Non-Goals:**

- Plan *authoring* (conversation-agent/planner adoption) — the plan file surface
  exists precisely so this can come later.
- The provenance bridge (change D: bus-adapter `ArtifactRegistry`, run-lifecycle
  prov events) and the prov event port (change B).
- Harness-side deletion of `FilesystemArtifactRegistry` (change E).
- Run cancellation/resume *commands*, TUI surfacing, report generation
  (`iterate_report`), target-assessment and ephemeral workflows.
- Linux `host.docker.internal` reachability (carried debt from change C).

## Decisions

### D1. Register the two analysis workflows directly, in assemble-order; keep deferring `assembleCoreRuntime`

The boot's registration section becomes:

```
const sandboxStep = registerSandboxStep(sandboxStepDeps);
const executeAnalysis = registerExecuteAnalysis(buildExecuteAnalysisDeps(sandboxStep));
const dataProfile = registerDataProfileWorkflow(dataProfileDeps);   // existing
registerSandboxReaper(...); registerWatchdog(...); registerNotificationSweep(...);  // D5
await launchDbos(...)
```

Child-before-parent mirrors `assemble.ts:75-76`; everything still lands in one
pre-launch cohort, which is the invariant `assemble.ts` actually protects (one
`applicationVersion` stamp, recovery finds every workflow by name at launch). This
**revises change C's D1 recorded debt** ("when executeAnalysis lands, the cli moves
to `assembleCoreRuntime`"): the full root also registers target-assessment and
ephemeral and unconditionally builds the conversation agent
(`assemble.ts:72-85`) — three dep bundles this change does not exercise. The debt
is restated: move to `assembleCoreRuntime` when the conversation agent is adopted.
Alternative rejected: `registerAnalysisWorkflows` — structurally unusable (Context;
flag upstream).

### D2. The cli replicates the `executePlan` trigger flow

`run.ts` performs dedup → reserve → authorize → launch with the same calls the tool
makes (`queryActiveRun`, `insertRun` + `RunDedupCollisionError`, `updateRunStatus`
on the failure paths, `runAuthorizer.authorize`, `createDbosRunLauncher().launch`
with `workflowId = runId`), and builds `ExecuteAnalysisInput` the same way
(`renderStepPrompt` per step, agent/resources/timeout maps, `planSummary` = title
or narrative slice, `ownsMandate` from the authorization).

Alternatives rejected:

- *Invoke the tool off-label* — `createExecutePlanTool(...).execute(input, ctx)`
  needs a synthetic `ToolContext` and an analysis-scoped `RequestSession`, and
  emits `data-run-card` parts at a chat stream the cli doesn't render. Off-label
  use of a chat-route contract to avoid ~80 lines is a worse coupling.
- *Extract an additive harness trigger helper* (the `triggerDataProfile` shape) —
  the honest version refactors `execute-plan.ts` to delegate, which exceeds the
  "additive riders only" harness budget this change inherits from C. If
  conversation-agent adoption later wants one shared flow, that change owns the
  extraction.

Drift risk is accepted and bounded: the replicated flow is part of the
`TODO(extend)`-marked dev surface (D3) that conversation-agent adoption replaces
wholesale.

### D3. Plan intake: file → validate → deterministic id → upsert

`inflexa run <analysis> --plan <file>` reads a JSON plan document and applies
exactly `executePlan`'s gates: `AnalysisPlanSchema.safeParse` then `validatePlan`
(topo-sort, unique output prefixes, known agent ids, resources on every step,
reserved step-id names). The plan id is derived, not minted:
`pln-` + first 8 hex of `sha256(analysisId + "\n" + <plan file bytes>)` — matching
the `/^pln-[a-f0-9]{8}$/` contract (`execute-plan.ts:47`). Determinism is what
makes the surface idempotent: re-running the same file hits `queryActiveRun` dedup
instead of double-launching; editing the file yields a new plan id (a genuinely
different plan). Hashing the analysisId in prevents cross-analysis id collisions
(`cortex_plans.plan_id` is the global PK; `loadPlan` is analysis-scoped, so a
collision would misroute to "plan not found").

Persistence goes through a new **additive** harness state function
`upsertPlan(pool, {planId, analysisId, plan, parentPlanId?})` — insert-if-absent
(`ON CONFLICT (plan_id) DO NOTHING`) beside `insertPlan` in `state/plans.ts`,
because `insertPlan` cannot take a caller id and the cli writing harness-owned
tables with raw SQL would smuggle schema knowledge across the package boundary.

The whole module carries the clearing contract in a `TODO(extend)` block: plan
authoring is the conversation agent's `generatePlan`; this file-based surface
exists only to exercise the run engine before that adoption, and both the intake
module and the replicated trigger flow (D2) are its blast radius.

### D4. `SandboxStepDeps` realizations

| Dep | Realization |
|---|---|
| `provider` | the existing proxy-backed provider (`ChatProvider extends AgentChat`) |
| `embedding` | `createEmbeddingProvider({...cfg.embedding, resolveBilling})` — same config the write-side indexer uses |
| `sandboxClient`, `workspaceFs`, `sessionsBasePath`, `pool`, `model` | identical to the data-profile wiring (`runtime.ts:271-289`) |
| `artifactRegistry` | **cli-side no-op stub**: `register` → `{registered: [], failed: [], failedCount: 0}`, `sync` → resolved void. Contract-honest (Context). `TODO(extend)`: replaced by the bus-adapter provenance bridge, change D of `docs/harness_integration-new/06-change-graph.md`. Alternative rejected: `createFilesystemArtifactRegistry` — it would write a `provenance-index.json` nothing reads (change E deletes it), and pointing the seam at a dead format makes D's cutover ambiguous instead of a stub→adapter swap |
| `buildAgent` | per-step: map `SandboxAgentBuildContext` → `SandboxAgentDeps` (threading `ctx.lineageCollector`, `ctx.blockerHolder`, `ctx.sandbox`, `ctx.stepWritePrefix`, `ctx.nextFunctionId`, `ctx.deadlineMs`, plus composition-level provider/pool/fs/embedding/skillsDir/bioKeys/model), then `createSandboxAgents(deps)[ctx.input.agentId]`; unknown id throws with the known-id list (defense-in-depth — `validatePlan` already gates) |
| `resolveWritePrefix` | `join(sessionsBasePath, runStepDir(input.analysisId, input.runId, input.stepId))` — the harness's own path convention (`workspace/paths.ts:206-211`), absolute like data-profile's `allowedWritePrefix` |

### D5. Register the sandbox-hygiene scheduled workflows at boot

All three, between workflow registration and launch: reaper
(`{pool, sandboxClient}`), watchdog (`{queryActiveSandboxes: () =>
queryActiveSandboxes(pool), sandboxClient}`), notification sweep (`{pool}`).
Rationale: the kill/resume verification in scope *creates* the situations they
exist for — killed hosts orphan containers (reaper) and dead sandboxes must
convert to prompt step failure rather than deadline-long hangs (watchdog). They
also retroactively cover profile runs, closing a latent change C gap. Trade-off
accepted: the runtime now runs three cron workflows whenever booted; they are
no-ops on an idle system.

### D6. `ExecuteAnalysisDeps` realizations

`pool`/`provider`/`sessionsBasePath` as data-profile; `sandboxStepCallable` from
D1; `embedding` instance as D4; `synthesisModel = model` (one model id in the cli
config; splitting is a later config concern); `bioKeys` from config;
`runCharge = createNoopRunCharge()`; `runAuthorizer = createLocalRunAuthorizer()`;
`synthesisEnabled` left at its default (true) — the skeleton should prove the
whole body including synthesis, and the literature tools degrade to normal tool
errors without optional keys (change C's D6 precedent for `bioKeys`).

### D7. Command shape mirrors `inflexa profile`

`run.ts` follows `profile.ts` beat for beat: resolve analysis ref → pre-flight
(same `HarnessBootError` mapping; sandbox-image check) → boot → stage inputs
(mirror reconciliation; empty manifest short-circuits) → `upsertAnalysis` ledger
seed → plan intake (D3) → trigger (D2) → **block until `cortex_runs.status` leaves
`running`** (the workflow executes in this process's DBOS runtime; exiting after
launch orphans it until a future boot), with clack narration (spinner over
step-level progress from `queryStepsByRun` + the `dbos.operation_outputs`
narration pattern profile established; best-effort reads that never abort the
wait). Ctrl+C detaches with DBOS-recoverable semantics. Terminal reporting maps
the 5-value `RunStatus` (minus `running`) to distinct outcomes, including
partial/failed step breakdowns from `ExecuteAnalysisResult`-shaped ledger reads.
`--status` is read-only (`queryRunsByAnalysis` + `queryStepsByRun`; never boots,
reuses the live runtime's pool or a throwaway connection — the
`loadDataProfileStatus` pattern). A missing completed data profile
(`loadDataProfileStatus`) warns and proceeds — agents orient on
`dataprofile/profile-summary.md` but nothing hard-fails without it.

### D8. Barrel growth (the one harness-side edit beyond `upsertPlan`)

Additive exports: `registerExecuteAnalysis`/`registerSandboxStep` + deps/input/
result types, `SandboxAgentBuildContext`/`SandboxAgentDeps`/`SandboxStepCoords`,
`createSandboxAgents` (+ `SANDBOX_AGENT_META`), `AnalysisPlanSchema`/`PlanStep`
types, `validatePlan`, `renderStepPrompt`, `insertPlan` is NOT needed —
`upsertPlan`/`loadPlan`, run state (`insertRun`, `queryActiveRun`,
`updateRunStatus`, `queryRun`, `queryRunsByAnalysis`, `queryStepsByRun`,
`RunDedupCollisionError`), and the three scheduled-workflow registration
functions. `createDbosRunLauncher`, `createNoopRunCharge`,
`createEmbeddingProvider`, `runStepDir` availability to be confirmed at
implementation (export whatever of these the barrel lacks).

## Risks / Trade-offs

- **[Never-run engine]** `executeAnalysis`, the scheduler, fail-fast/pause
  cascades, and the post-step pipeline have never executed anywhere. → That is the
  point of the skeleton; expect an E2E-findings task group like change C's (three
  live rounds each found a real bug). Budget verification accordingly.
- **[Replicated trigger drift]** D2's flow can drift from `execute-plan.ts` if the
  harness contract evolves. → Bounded by the `TODO(extend)` clearing contract;
  the flow is five exported calls, each type-checked against the barrel.
- **[Plan-file foot-guns]** A hand-written plan can request huge resources or
  hours-long timeouts. → `validatePlan` + the plan schema gate structure, not
  scale; the sandbox client's configured resource-limit defaults still apply.
  Accepted for a dev surface; the planner owns sane plans later.
- **[Scheduled-workflow blast radius]** Reaper/watchdog now run during profile
  sessions too. → Deliberate (D5); both act only on rows/containers the harness
  itself created.
- **[Synthesis cost]** `synthesisEnabled: true` spends LLM budget on every run.
  → It is the real product path; a config off-switch is a one-line follow-up if
  E2E shows it dominating dev iteration time.
- **[Stub registry means no external provenance]** Run outputs land in
  `cortex_artifacts` + on disk but produce no signed prov events yet. → Explicitly
  sequenced: change D exists for this; the stub's `TODO(extend)` names it.

## Migration Plan

Additive throughout: new cli files + one additive harness state function + barrel
exports. No cli SQLite schema change; `cortex_plans`/`cortex_runs` already exist in
the provisioned Postgres (`initCortexState`). Rollback = don't use `inflexa run`;
nothing passive changes. Change C's pre-flight/boot/staging surfaces are reused,
not modified — `inflexa profile` behavior is unchanged except for the newly
registered scheduled workflows.

## Open Questions

- Final command name and flag shape (`inflexa run <analysis> --plan <file>` is the
  working shape; the capability spec constrains behavior, not naming) — decide at
  implementation, as with change C.
- Whether `--status` should also surface per-step sandbox liveness (watchdog's
  view) or stay at ledger granularity — start ledger-only; extend if the E2E shows
  it's needed to debug hangs.
