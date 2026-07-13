# Proposal: add-prior-runs-briefing

## Why

The briefing system (add-conversation-briefings) shipped with a single producer — the data profile — so the main conversation still has no ambient awareness of the analysis's execution history: the agent discovers prior runs only if it thinks to call `inspect_run` cold. Meanwhile the planner still receives that same history as `dataContext`/`priorRuns` strings the conversation agent re-types by hand into `generate_plan`, concatenated into a hand-built first user message (`src/tools/research/generate-plan.ts`) — lossy, unversioned, and duplicating exactly what briefings were built to replace. This change adds prior-run awareness as the second standing briefing and completes the deferred planner migration, so both loops share the same declarative definitions.

## What Changes

- New `prior-runs` standing `BriefingDefinition` in `src/prompts/briefings/`: a lightweight INDEX of the analysis's terminal runs — per run: run id, plan title/question, completion timestamp, and step outcomes (n/m completed, failed step names). It NEVER contains the synthesis body or step summaries — it is awareness plus pointers, ending with a nudge that details are retrievable just-in-time via the `inspect_run` tool. At most ~2 lines per run; at most the 10 most recent runs, with an explicit "and K older runs" line when more exist (no silent truncation). Caption like `2 prior runs · latest run_8f3a 6/7 steps · 2026-07-10`. Omitted entirely when the analysis has no terminal runs (omit-on-missing rule).
- New run-index input reader over the real ledgers: `cortex_runs` (`queryRunsByAnalysis`) + `cortex_step_executions` (`queryStepsByRun`) + plan title via `loadPlan`, producing the typed input the pure `render` consumes.
- Main conversation: `prepareChatTurn` composes `prior-runs` as a second standing briefing after `data-profile` (array order: data-profile, prior-runs) — persisted, pinned, briefing-card surfaced, per the shipped standing semantics.
- New `prior-plan` standing `BriefingDefinition`: the plan being iterated, serialized from the stored plan (migrating `formatPriorPlan` — narrative, one line per step, preserve-step-IDs guidance).
- **BREAKING** — planner migration: `generate_plan` stops hand-concatenating `dataContext`/`priorRuns`/prior-plan blocks into one first message. It composes briefings (data-profile, prior-runs, prior-plan) from harness-owned state as unpersisted initial messages of the planner sub-agent loop; the research question and user constraints remain the actual user message. The tool's `dataContext` and `priorRuns` input params are removed — the harness reads its own ledgers instead of trusting conversation-agent-retyped context. Same definitions shared between main conversation and planner — that reuse is the point.
- Mode/persistence split: all three definitions are standing; for the planner they are unpersisted initial messages (sub-agent transcripts are ephemeral, no briefing cards), for the main conversation `prior-runs` is persisted alongside `data-profile`.

## Capabilities

### New Capabilities

- `conversation-briefings`: extended with ADDED requirements only — the `prior-runs` definition and its index/no-body/capping rules, main-conversation composition order, the `prior-plan` definition, and planner composition of unpersisted briefings. (The capability is introduced by the in-flight `add-conversation-briefings` change and does not yet exist in `openspec/specs/`, so this change's delta is pure `## ADDED Requirements` — never MODIFIED against it.)

### Modified Capabilities

- `planning-enhancements`: the `generate_plan` invocation contract changes — the requirement covering the planner sub-agent loop's inputs is modified so the tool is called with `{ researchQuestion, userConstraints?, parentPlanId? }` and composes its context briefings itself instead of receiving `dataContext`/`priorRuns` strings.

## Impact

- **Harness code**: `src/prompts/briefings/` (two new definitions + fixtures + snapshot tests); new run-index reader in `src/state/` (over `src/state/runs.ts`, `src/state/step-executions.ts`, `src/state/plans.ts`); `src/app/chat-turn.ts` (`composeStandingBriefings` gains prior-runs); `src/tools/research/generate-plan.ts` (input schema shrinks; prompt assembly replaced by briefing composition; `formatPriorPlan` moves into the `prior-plan` definition).
- **Prompts**: the conversation agent's `generate_plan` guidance ("pass all relevant context") updates to the new input surface; the planner prompt's expectations about its first message update to `<briefing>` blocks.
- **Storage**: none — prior-runs rides the existing `briefing` envelope kind; planner briefings are never persisted.
- **Breaking surface**: `generate_plan`'s tool input schema (model-facing). No host/embedder API changes; the CLI's briefing-card rendering picks up the new card with zero changes.
