## 1. Adhoc executor agent

- [x] 1.1 Rename `src/agents/sandbox/ephemeral-executor.ts` → `adhoc-executor.ts`; change the agent id to `adhoc-executor`, keep `plannable: false`, and rebuild with default `createSandboxAgent` opts (drop `readOnly:true` and `appendAnalysisStepStandards:false` so write tools and standards are present).
- [x] 1.2 Rewrite the executor prompt body for the new contract: can create files under the step cwd, deliverable is persisted files + `summary.md`, no "results inline / cannot save files" language.
- [x] 1.3 Update `src/agents/sandbox/index.ts` registration and any `SANDBOX_AGENT_META` entry to the `adhoc-executor` id (roster stays 22; still catalog-excluded / non-plannable).
- [x] 1.4 Update every spec-named reference from `ephemeral-executor` to `adhoc-executor` in code (catalog exclusion lists, `PLANNABLE_*` filters).

## 2. runAdhoc workflow + briefing

- [x] 2.1 Add adhoc briefing composition that reuses `renderWorkspace` (writable cwd `runs/{runId}/adhoc/`) and `renderOrientation` (data-profile projection) with the caller prompt as the task section, and no upstream section. Replace `ephemeralSeed`.
- [x] 2.2 Add a `runAdhoc` DBOS workflow: insert run row (`workflow_name="runAdhoc"`, `planId` omitted), seed one `cortex_step_executions` row (`stepId="adhoc"`, `wave=0`, `agent_id="adhoc-executor"`), compose the briefing, and dispatch the existing sandbox-step workflow with a `SandboxStepInput`.
- [x] 2.3 Size the adhoc sandbox from `policy.adhoc` (default `{cpu:4,memoryGb:8}`), subject to the per-step clamp.
- [x] 2.4 Register `runAdhoc` with DBOS alongside `executeAnalysis`.

## 3. run_adhoc tool

- [x] 3.1 Add `src/tools/run-adhoc.ts`: input `{prompt:string}` (min 1), authorize via `RunAuthorizer`, launch via `RunLauncher.launch` (`workflowId=runId`), emit a `data-run-card`, return `{runId}` without awaiting.
- [x] 3.2 Register `run_adhoc` on the conversation agent and remove `run_ephemeral` from its tool set.

## 4. Deletions

- [x] 4.1 Delete `src/execution/ephemeral-runner.ts` (deadline math, `ephemeralSeed`, private sandbox create/teardown, no-op emit, unused `maxIterations` input override).
- [x] 4.2 Delete `src/tools/run-ephemeral.ts`.
- [x] 4.3 Remove `RunLauncher.launchAndAwait` (ephemeral was its only consumer) and the `ephemeral:` workflow-id prefix + its pre-recovery cancellation sweep.
- [x] 4.4 Rename the `ResourcePolicy.ephemeral` field to `ResourcePolicy.adhoc` and update the composition-root wiring.

## 5. inspect_run / synthesis gating

- [x] 5.1 In `src/tools/research/inspect-run.ts` `formatRun`, return `synthesisPath: null` for plan-less runs (extend the existing produced-outcome gate to also require a plan).
- [x] 5.2 Ensure the adhoc run seeds no reserved synthesis row and runs no synthesis phase.

## 6. Tests

- [x] 6.1 Unit: `run_adhoc` authorizes, launches via `launch`, emits run card, returns `{runId}` without awaiting; `run_ephemeral` is absent from the conversation-agent registry.
- [x] 6.2 Unit/integration: `runAdhoc` inserts a null-`plan_id` row, seeds one `adhoc` step, dispatches the sandbox-step workflow, and its executor can write + execute a file that registers in `cortex_artifacts` with `source_run`/`source_step`.
- [x] 6.3 Unit: two concurrent adhoc runs in one analysis both insert (no `RunDedupCollisionError`).
- [x] 6.4 Unit: `inspect_run` reports `synthesisPath:null` and an `adhoc`-step `summaryPath` for a completed adhoc run.
- [x] 6.5 Unit: `policy.adhoc` overrides the default sandbox size; absent policy falls back to `{cpu:4,memoryGb:8}`.
- [x] 6.6 Update `agent-roster` / `sandbox-catalog` tests for the `adhoc-executor` id.

## 7. Specs, docs, and companion change

- [x] 7.1 Run `openspec validate promote-ephemeral-to-adhoc-run --strict` and fix any issues.
- [x] 7.2 Update `harness/CLAUDE.md` / `CONTEXT.md` references from `runEphemeral`/`run_ephemeral` to the adhoc run + tool.
- [x] 7.3 File the companion `cli` change: drop the `ephemeral:` boot-sweep rule from the cli `harness-runtime` spec + implementation (sequenced after harness publishes; sidebar needs no change).
