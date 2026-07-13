# Proposal: add-step-handoff-briefings

## Why

A downstream analysis step's sandbox agent starts blind to what its upstream `depends_on` steps actually produced. Its initial message is the plan-time prompt (`renderStepPrompt` renders only design-time fields, assembled at dispatch before any step has run — `src/tools/execute-plan.ts`), and the shared orientation prompt (`src/prompts/sandbox-standards.ts`, "Orient First" step 5) tells each agent to rediscover upstream outputs itself via `list_files` / `workspace_search` / `read_file`. The agent burns orientation turns re-deriving context the harness already produced: every upstream step ends with a deliberately compact interpretation summary (`output/summary.md`, the step-interpretation-summary capability) and a reconciled artifact manifest. The briefing system (add-conversation-briefings) made injectable first-turn context a first-class, testable concept — workflow step loops should receive upstream results through it instead of self-discovery.

## What Changes

- New `step-handoff` **standing** `BriefingDefinition` in `src/prompts/briefings/step-handoff.ts` (+ colocated fixture + snapshot test). Input is one upstream step's handoff payload — step id, step name, interpretation-summary markdown, and artifact paths. Content is the upstream step's interpretation summary verbatim (unlike run synthesis, these summaries are already size-disciplined — they ARE the payload) plus the upstream step's artifact locations as sandbox-canonical absolute paths. Caption format: `step s2 "normalize" · 4 artifacts`.
- **One briefing per upstream step**, injected in `depends_on` order: the `sandbox-step` child workflow body composes them (via `composeBriefing`) before `runAgent` and prepends the briefing messages to the loop's initial messages, ahead of the step prompt.
- Workflow loops are ephemeral (the DBOS step cache is the durability; there is no thread history), so these briefings are **unpersisted structured initial messages** — no `briefing` envelope rows, no `loadRecent` pinning, no briefing-card parts. Standing mode here means: injected once at loop start, immutable for the loop's lifetime.
- The parent (`executeAnalysis`) projects upstream identity into the child input: `ExecuteAnalysisInput` gains a `nameByStepId` map (populated by `execute_plan` alongside the existing `*ByStepId` maps) and `buildChildInput` derives `handoffSources: { stepId, name }[]` from the plan DAG. The child loads each upstream's `output/summary.md` and artifact listing inside a checkpointed durable step, then composes purely.
- **Omit-on-missing**: a step with no `depends_on` gets no handoff briefing; an upstream step that produced no interpretation summary (the summary pipeline is best-effort) contributes no briefing — never a placeholder.
- **The ad-hoc upstream-context mechanism is replaced, not duplicated**: the "Orient First" self-discovery instruction for upstream outputs in `sandbox-standards.ts` is rewritten to point at the `<briefing name="step-handoff">` blocks (deep inspection of a specific referenced artifact via `read_file` remains; blind re-discovery of upstream results goes), and the sandbox orientation prompt gains the one-sentence `<briefing>` trust statement. `renderStepPrompt` stays design-time-only — the briefing is the single injected channel for upstream runtime context.

Deferred deliberately: handoff briefings for run synthesis or cross-run context (prior-runs handoff is its own change), per-briefing token budgets, any persistence of workflow-loop briefings.

## Capabilities

### New Capabilities

None. (The `conversation-briefings` capability is introduced by the in-flight add-conversation-briefings change; this change extends it with a delta.)

### Modified Capabilities

- `conversation-briefings`: ADDED requirements — the `step-handoff` standing briefing definition (input, content, caption), workflow-loop composition rules (child-workflow-body composition, unpersisted initial messages, `depends_on` ordering, omit-on-missing, no storage/briefing-card involvement), and the single-channel replacement rule.
- `step-interpretation-summary`: ADDED requirements — the consumption side: the interpretation summary becomes the handoff payload delivered to dependent steps' agent loops, and a missing summary degrades to omission (consistent with the existing best-effort discipline). No existing production-side requirement changes.

## Impact

- **Harness code**: new `src/prompts/briefings/step-handoff.ts` (+ `step-handoff.fixture.ts`, `step-handoff.test.ts`, snapshot); `src/workflows/execute-analysis.ts` (`ExecuteAnalysisInput.nameByStepId`, `buildChildInput` → `handoffSources`); `src/tools/execute-plan.ts` (populate `nameByStepId`); `src/workflows/sandbox-step.ts` (`SandboxStepInput.handoffSources`, a `handoff.load` durable step, briefing composition ahead of `input.prompt`); `src/prompts/sandbox-standards.ts` (orientation rewrite + `<briefing>` trust sentence).
- **Storage**: none. No new tables, columns, or envelope kinds — workflow-loop briefings are never persisted.
- **Specs**: delta on `conversation-briefings` (in-flight capability) and `step-interpretation-summary`; `step-execution-tracking` is unchanged (no ledger involvement — upstream identity comes from the plan projection, completion gating already lives in the scheduler).
- **Behavioral**: downstream steps see upstream results on turn one; orientation guidance stops directing agents to re-discover them, so orientation turns shrink for dependent steps.
