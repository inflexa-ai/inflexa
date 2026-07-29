## 1. Invocation Identity and Persistence

- [x] 1.1 Add `invocationId` to `ToolContext`, populate it from each AI SDK `toolCallId`, and update context-shape/dispatch tests.
- [x] 1.2 Add deterministic ad hoc plan/run identity helpers scoped by tool name, analysis id, and invocation id, with stable-format and separation tests.
- [x] 1.3 Add analysis-scoped insert-if-absent run reservation by deterministic `runId`, including active, terminal, concurrent, and cross-analysis collision tests.
- [x] 1.4 Build and persist a valid mechanical one-step `AnalysisPlan` with insert-if-absent/reload semantics and tests proving that the first routing decision wins.

## 2. Utility Routing

- [x] 2.1 Extract reusable planner resource-estimation guidance so planning and ad hoc routing share lower/default/upper bound language without duplicating policy rules.
- [x] 2.2 Implement the tool-free, forced-structured ad hoc router over the plannable agent catalog and persisted data-profile orientation with a 10-second wall-clock bound.
- [x] 2.3 Validate agent and resource outputs independently, implement `scientific-executor` and bounded resource fallbacks, and record selection rationale/failure class.
- [x] 2.4 Add router tests for specialist selection, no match, unknown id, malformed resources, provider error, timeout, absent policy, and configured CPU/memory/GPU bounds.
- [x] 2.5 Add required utility provider/model dependencies to the harness composition interfaces and construct router sessions with utility-model attribution.

## 3. Unified Analysis Launch Tool

- [x] 3.1 Replace `execute_plan` with `execute_analysis` and its flat refined `{ mode, planId?, request? }` schema, preserving approved-plan lookup, validation, deduplication, authorization, run-card, and async launch behavior.
- [x] 3.2 Implement ad hoc mode as route → insert/reload internal plan → deterministic run reservation → authorize-if-new → DBOS launch, returning an existing run for duplicate invocation delivery.
- [x] 3.3 Pass the ordinary budget/session/step maps plus `synthesisEnabled: false` for ad hoc and `synthesisEnabled: true` for plan mode.
- [x] 3.4 Update the conversation prompt and tool description with explicit-intent consent, fallback-only agent selection, no second plan approval, async result inspection, and no agent-supplied subagent override.
- [x] 3.5 Add unified-tool tests for exact mode fields, plan-mode parity, explicit ad hoc launch, duplicate delivery before/after terminal state, deliberate identical re-call, authorization/launch failures, and run-card emission.

## 4. Replay-Stable Synthesis

- [x] 4.1 Move `synthesisEnabled` from `ExecuteAnalysisDeps` to optional `ExecuteAnalysisInput`, resolve absent to true, and use that snapshot for both ledger seeding and synthesis execution.
- [x] 4.2 Add workflow tests proving ad hoc input yields one step/no synthesis row/completed status, planned input synthesizes, and legacy persisted input defaults to synthesis enabled.
- [x] 4.3 Update workflow comments, exports, fixtures, and integration callers to use the input-owned synthesis contract.

## 5. Retire Ephemeral Execution

- [x] 5.1 Remove `run_ephemeral`, the ephemeral workflow/runner tests, agent definition, prompt, catalog entry, runtime registration, and conversation dependency wiring.
- [x] 5.2 Remove `RunLauncher.launchAndAwait` and its DBOS implementation after confirming no remaining production caller.
- [x] 5.3 Remove `ResourcePolicy.ephemeral` and update schemas, tests, composition comments, and exports to use only per-step ceilings and machine budget.
- [x] 5.4 Remove ephemeral-specific read-only provisioning while preserving and regression-testing the generic sandbox-agent `readOnly` contract.
- [x] 5.5 Replace prompt, tool-description, source-comment, and test references that recommend or special-case `run_ephemeral` with the unified ad hoc contract.
- [x] 5.6 Retain the executor-scoped legacy `ephemeral:*` pre-launch sweep as a migration hook and test that it cancels old pending rows before recovery while no new path creates them.

## 6. Verification

- [ ] 6.1 Run the focused tool, router, state, workflow, runtime-assembly, agent-catalog, prompt, and resource-policy test suites and fix regressions.
- [ ] 6.2 Run harness typecheck, lint/format checks, and the subsystem test command required by `harness/CLAUDE.md`.
- [x] 6.3 Verify the built package exports the new composition/tool contracts, contains no ephemeral executor surface beyond the documented legacy sweep, and is ready for the coordinated CLI embedder change.
