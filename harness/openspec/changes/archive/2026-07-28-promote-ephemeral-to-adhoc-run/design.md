# Design — Promote Ephemeral Execution to Adhoc Runs

## Context

The ephemeral path today is a parallel universe: `run_ephemeral` (`src/tools/run-ephemeral.ts`) blocks the chat turn via `RunLauncher.launchAndAwait`, and `runEphemeralBody` (`src/execution/ephemeral-runner.ts`) creates its own read-only sandbox, runs `createEphemeralExecutorAgent` against a single free-text user message (`ephemeralSeed`), and tears everything down. Every mechanical property diverges from the planned-step path:

| Property | Planned step (`sandbox-step.ts`) | Ephemeral today |
|-|-|-|
| Wall clock | 3600s (`DEFAULT_STEP_TIMEOUT_SECONDS`) | 120s absolute, shared with LLM think-time |
| Mount | RW at `runs/{runId}/{stepId}`, RO tree | RO tree only |
| Write tools | yes (+ standards prompt → `summary.md`) | none |
| Provenance | frames → `ProvenanceCollector` → registry | frames produced by sandbox-server, discarded by host |
| Durability | resumed on boot | boot sweep cancels `ephemeral:` PENDING workflows |
| Progress | emitted (`data-step-activity`, file tree) | `emit: () => {}` |
| Results | `summary.md` via `inspect_run` | inline text, lost on disconnect |

The 120s deadline is computed once at workflow start and handed to every `execute_command` as an absolute cutoff, so model reasoning time between commands consumes the exec budget — the observed "times out after one command." The turn cap was never the constraint: the ephemeral executor already has the default `maxIterations = 50` (`SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS`, `agents/sandbox/types.ts:73`).

Both executor families receive instructions identically — static per-agent system prompt, everything else in the first user message — so unification is a question of who composes that message, not of agent architecture.

## Goals / Non-Goals

**Goals:**

- An ad-hoc executor that can write files and execute them, with its artifacts provenance-tracked and readable by all later runs and adhoc runs.
- Async, durable execution: surviving disconnects and restarts, visible in the sidebar across refreshes and new chats.
- Step-standard resource limits (3600s wall clock, agent-meta turn cap).
- Maximal reuse: the adhoc run is a degenerate one-step run dispatched through the existing sandbox-step workflow; ephemeral-only machinery is deleted, not adapted.
- Preserve the *ceremony* difference: one free-text prompt, no plan authoring, no review.

**Non-Goals:**

- Auto-waking the conversation agent on completion (future feature; pull-only via `inspect_run` is the contract, matching the deliberate retirement of `run-result-writer`).
- `report_blocker` for adhoc runs (revisit when auto-wake lands; the executor notes obstacles in `summary.md`).
- Per-call agent selection (`agent?` input) — v1 fixes `adhoc-executor`; `buildAgent` already dispatches on `agentId`, so this is a cheap later extension.
- Synthesis for adhoc runs.
- Any cli-side change (separate change in `cli/`: drop the `ephemeral:` boot sweep; sidebar needs nothing — it polls ledger rows).

## Decisions

**D1 — Adhoc run = run row + one sandbox-step dispatch.** A thin `runAdhoc` DBOS workflow inserts a run row (`workflow_name = "runAdhoc"`, `plan_id = NULL`), seeds exactly one `cortex_step_executions` row (`stepId = "adhoc"`, wave 0, `agent_id = "adhoc-executor"`), composes the briefing, and dispatches the existing sandbox-step workflow with a synthetic `SandboxStepInput`. Nothing in `SandboxStepInput` assumes a plan exists (`{analysisId, runId, stepId, agentId, level, prompt, resources, timeoutSeconds, runSession}`), so sandbox lifecycle, mounts, exec protocol, timeout, `ProvenanceCollector`, `syncArtifacts`, progress emission, and the `summary.md` convention are inherited unchanged. *Alternative rejected:* synthesizing a one-step plan and running `executeAnalysis` — it would mint a `planId` (breaking the null-`plan_id` discriminator) and drag in plan validation and the synthesis phase, which would then need special-casing back out.

**D2 — Null `plan_id` is the discriminator.** The `cortex_runs` schema already has nullable `plan_id` and `insertRun` already accepts `planId?`; no schema migration. Consumers distinguish adhoc runs by `plan_id IS NULL` (plus `workflow_name`). Consequence to codify: the partial-unique index `idx_cortex_runs_active_plan` on `(analysis_id, plan_id) WHERE active` does not constrain NULL `plan_id` rows (SQL NULLs are distinct), so concurrent adhoc runs are permitted — desired behavior, locked in by spec rather than left accidental.

**D3 — Instruction channel stays free text; composition is folded.** `run_adhoc` input is `{prompt: string}`. The launcher composes the briefing from the shared sections: task = the raw prompt verbatim, `renderWorkspace` (writable cwd `runs/{runId}/adhoc/`, RO analysis root), `renderOrientation` (bounded data-profile projection — an upgrade over today's blind `ephemeralSeed`). `renderUpstream` does not apply (no `depends_on`); the prompt may reference prior runs' outputs by path, readable via the RO tree. *Alternative rejected:* a structured mini-brief (`question`/`acceptance_criteria`/…) — re-imports plan ceremony; the conversation agent already authors good prose asks.

**D4 — Results are the step's `summary.md`; no synthesis.** The adhoc executor gets the analysis-step standards prompt, so `summary.md` materializes by the existing convention, and `inspect_run` → `summaryPath` → `read_file` works untouched. Synthesis never runs for a plan-less run: no reserved synthesis ledger row, no synthesis outcome, and `inspect_run`'s `formatRun` must stop fabricating `runs/{runId}/synthesis.json` for completed plan-less runs (return `synthesisPath: null`).

**D5 — Fire-and-forget launch, standard recovery.** `run_adhoc` mirrors `execute_plan`: `RunLauncher.launch` with `workflowId = runId`, return `{runId}` immediately, emit a `data-run-card` display event. The chat turn ends honestly ("started run X"); sidebar visibility comes from the ledger rows it already polls. `launchAndAwait` is deleted (ephemeral was its only consumer), along with the `ephemeral:` workflow-id prefix, the cancel-on-disconnect wiring, and the zero-recovery boot rule — adhoc workflows recover like any durable run. *Alternative rejected:* bounded inline wait (await ~20s then detach) — deferred; ship pure async first and measure whether quick-question latency actually stings.

**D6 — `adhoc-executor` replaces `ephemeral-executor` with default construction.** Same registry slot (roster stays 22, `plannable: false`, catalog-excluded), rebuilt with default sandbox-agent opts: write trio present, `appendAnalysisStepStandards: true`, no `readOnly`, prompt rewritten for the new contract (can create files; results land in the step tree and `summary.md`). Turn budget is agent-meta-owned: inherit the default 50; tune later via `defaultMaxSteps` like other specialists. The unused `maxIterations` workflow-input override is dropped, not surfaced as a tool arg.

**D7 — `ResourcePolicy.ephemeral` → `ResourcePolicy.adhoc`.** Breaking rename of the embedder sizing knob, keeping the vocabulary coherent with the tool and run kind. Same default `{cpu: 4, memoryGb: 8}` and per-step clamp.

## Risks / Trade-offs

- [Quick questions get slower: a 10s "what columns does this CSV have?" now costs a launch turn + an inspect turn] → Accepted for v1; the bounded-inline-wait refinement (D5) is the designed escape hatch if usage shows pain. The future auto-wake feature removes the second turn entirely.
- [A model trained on the old contract may avoid file creation ("cannot save files" lore)] → The tool id, description, and executor prompt all change together; the old tool disappears rather than changing meaning under the same name.
- [Concurrent adhoc runs can write concurrently] → They cannot conflict: each run has its own `runs/{runId}/adhoc/` RW mount; the shared tree is RO.
- [`inspect_run` currently fabricates `synthesisPath` for any completed run] → Explicit requirement in the `run-synthesis-outcome` delta; small guard in `formatRun`.
- [Stale cli boot sweep would cancel nothing (prefix gone) but remains dead code] → Harmless in the interim; companion cli change deletes it. Ordering follows the established harness-publishes-before-cli-consumes flow.
- [Plan-schema `maxSteps` is authored but never enforced (agent meta is the enforcement point)] → Out of scope; noted for `resolve-harness-wiring-gaps`. This change specs the adhoc turn budget as agent-meta-owned so it does not inherit the dangling field.

## Migration Plan

1. Land harness change (delete ephemeral paths, add `run_adhoc` + `runAdhoc` + `adhoc-executor`, spec deltas).
2. Publish harness; then the companion cli change consumes it (two-step promotion per repo convention): drop the `ephemeral:` boot-sweep rule from the cli `harness-runtime` spec and its implementation.
3. No data migration: no schema change; no existing rows are affected. In-flight `ephemeral:` workflows at upgrade time are terminal within one boot cycle (old sweep or natural completion) before the sweep is removed.

Rollback: revert the harness release; `run_ephemeral` returns with its old semantics. No persistent state depends on the new shape (adhoc run rows are ordinary run rows).

## Open Questions

- None blocking. Deferred by decision: bounded inline wait (D5), `agent?` selector (Non-Goals), `report_blocker` (Non-Goals), auto-wake (Non-Goals).
