# Tasks — resolve audited harness wiring gaps

Decisions are resolved (see `design.md`). Remaining open items are called out
per decision. `openspec validate resolve-harness-wiring-gaps --strict` passes.

## 0. Decisions — RESOLVED

- [x] **Decision 1** — Regulatory grounding: remove references to the tool that
  does not exist (`search_regulatory_guidance`); keep `find_approval_precedent`
  (the tool exists) pending a wiring call.
- [x] **Decision 2** — Boot lifecycle: the harness owns an ordered boot sequence
  (`bootHarness`), `assembleCoreRuntime` stays pure; embedder wires the shutdown
  handle + its own telemetry.
- [x] **Decision 3** — Report-builder gets `report-html` skill tools (option A).
- [x] **Decision 4** — "Change 9" (the 402-resume entry point) does not exist in
  this repo; the resume module is coherent but unreachable. Retire-vs-keep left
  to the owner; the phantom "change 9" reference was corrected.

## 1. Decision 1 — Regulatory grounding

- [x] Remove `search_regulatory_guidance` call instructions from the four
  `prompts/target-assessment/briefs/*` files
- [x] Correct the false `state/init.ts` comment (no such tool is wired; point at
  the real corpus files)
- [x] **`find_approval_precedent` wired — option A.** A deterministic pre-synthesis
  `ta-approval-precedents` `DBOS.runStep` queries openFDA once for the dossier's
  candidate indication and injects a `## FDA approval precedents` block into all
  four synthesis prompts (synthesis stays single-shot). The orphan `defineTool`
  wrapper was removed — its openFDA fetch became a plain `fetchApprovalPrecedents`
  co-located with the synthesis. The four briefs were rewritten from "call the
  tool" to "use the supplied block". Delivered in the follow-up change
  `ground-synthesis-with-approval-precedents`.

## 2. Decision 2 — Boot sequence

- [x] `runtime/boot.ts` `bootHarness` — ordered steps (telemetry → validate
  skills → state init → connection budget → assemble → beforeLaunch → launch);
  returns `{ runtime, shutdown }`; boot-step errors propagate
- [x] Barrel export `bootHarness` + `BootHarnessDeps` / `BootedHarness`
- [x] `runtime/boot.test.ts` — fail-fast on bad skillsDir before pool/launch; telemetry init runs first
- [x] Telemetry kept injectable (default no-op) so the CLI's own OTel is not double-initialized (would print a banner into the TUI)
- [x] **CLI adoption — done.** `cli/src/modules/harness/runtime.ts` now collapses onto one `bootHarness` call: `sweepEphemeral` + agent-switch install + the sandbox-hygiene crons moved into `beforeLaunch`; `initTelemetry`/`exit` are CLI-side no-ops; the shutdown hook routes through `booted.shutdown`. The `initState`/`assemble`/`launch` boot seams collapsed to one `boot: typeof bootHarness` seam. CLI typecheck clean of harness errors; `runtime.test.ts` (28 tests) green. Still wants a `bun run dev` smoke test for the live instance-lock / shutdown-ordering path.

## 3. Decision 3 — Report-builder skills — DONE

- [x] `skillsDir` threaded `ConversationAgentDeps` → `IterateReportDeps` → `ReportRunnerDeps`
- [x] `createSkillTools({ skillsDir, skills: ["report-html"] })` wired into the report-builder roster (`execution/report-runner.ts`)
- [x] CLI supplies `skillsDir` to the conversation deps; verified end-to-end (CLI `tsc` clean of harness errors after `dist` rebuild)
- [x] `iterative-report` spec delta: report-builder has `report-html` skill-tool access
- [x] Removed the orphan `skills/report-pdf` + `skills/report-pptx` packs (no agent, no roster, no PDF/PPTX render path referenced them); updated the `skills/` README and added an `agent-skill-assignment` pack-inventory delta (23 → 21 packs)

## 4. Decision 4 — 402-resume path

- [x] Verified: `prepareExecuteAnalysisResume` is coherent internal-contract code, but unreachable (no caller, not on the barrel); "change 9" is phantom (this repo names changes by kebab slug, never numerically)
- [x] Retired the scaffolding (option B): deleted `resume-execute-analysis.ts` + its test; removed `bumpRunAttemptCount`, the `cortex_runs.attempt_count` column, `CortexRunRow.attemptCount`, and the `attempt` cache-busting thread through `execute-analysis.ts` / `sandbox-step.ts`. Kept the 402-PAUSE (`suspended_insufficient_funds` + DBOS-resumable `CANCELLED` parent).
- [x] Spec deltas: `run-state-persistence` (drop attempt_count / attemptCount / bumpRunAttemptCount) and `workflow-failure-lifecycle` (drop the resume scenario referencing the removed attempt naming; reframe resume as deferred)
- [x] Corrected the CLI `run.ts` "change 9" comment to point at the deferred `resume-analysis-after-budget-pause` change
- [x] Captured the deferred resume capability as the placeholder change `resume-analysis-after-budget-pause`

## 5. Close-out

- [x] CLI boot adoption (Decision 2) landed
- [x] `find_approval_precedent` wired via option A (Decision 1) — delivered in the follow-up change `ground-synthesis-with-approval-precedents`
- [x] All four decisions resolved and implemented; the only follow-on work is the two placeholder changes (`resume-analysis-after-budget-pause`, `ground-synthesis-with-approval-precedents`)
- [ ] `openspec archive resolve-harness-wiring-gaps` (the decision gate is complete)
