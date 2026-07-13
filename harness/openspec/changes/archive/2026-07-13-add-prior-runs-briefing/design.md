# Design: add-prior-runs-briefing

## Context

add-conversation-briefings shipped the contract and machinery: `BriefingDefinition<TInput>` (pure `render(input) → { content, caption }`, one file per definition under `src/prompts/briefings/`), the `composeBriefing` injection path that wraps content in `<briefing name="…">`, the `briefing` storage envelope, pinned-prefix `loadRecent`, briefing-card parts returned from `prepareChatTurn`, and the data-profile as the first standing briefing. Its design deliberately deferred two things this change delivers: prior-run awareness and the planner migration (D10 there already fixed the sub-agent shape: same definitions, composed as unpersisted initial messages).

Current state of the two consumers:

- **Main conversation** (`src/app/chat-turn.ts`): `composeStandingBriefings` composes exactly `[dataProfileBriefing]`. The agent learns about prior runs only by calling `inspect_run` (`src/tools/research/inspect-run.ts`), which reads `cortex_runs` via `queryRunsByAnalysis` and `cortex_step_executions` via `queryStepsByRun`, and hands back file *pointers* (`runs/{runId}/{stepId}/output/summary.md`, `runs/{runId}/synthesis.json`) for `read_file` — deliberately pull-only.
- **Planner** (`src/tools/research/generate-plan.ts`): `generate_plan` takes `dataContext`, `researchQuestion`, `priorRuns?`, `userConstraints?`, `parentPlanId?` and string-concatenates them (plus `formatPriorPlan(parentPlanId, plan)` when iterating) into one first `user` message. `dataContext` and `priorRuns` are the conversation agent's *retelling* of state the harness itself owns — the LLM re-types the data profile and run history into tool arguments.

Where prior-run truth lives: the `cortex_runs` ledger (run id, status, startedAt/completedAt, planId — `src/state/runs.ts`), the `cortex_step_executions` ledger (per-step status, error — `src/state/step-executions.ts`), plan title/narrative in `cortex_plans` (`loadPlan`, `src/state/plans.ts`), and the heavyweight bodies in files: `runs/{runId}/synthesis.json` and per-step `summary.md`.

**Hard constraint (user-set)**: the prior-runs briefing must never inject the synthesis body or step summaries. It is an index — awareness plus pointers — with detail retrieved just-in-time through `inspect_run`.

## Goals / Non-Goals

**Goals:**

- Ambient prior-run awareness in the main conversation from the first turn, as a standing briefing that stays cheap: an index, hard-capped in both per-run size and run count.
- Complete the deferred planner migration: `generate_plan` composes the same briefing definitions from harness-owned state instead of hand-concatenating LLM-retyped strings.
- A third definition, `prior-plan`, carrying the plan being iterated — `formatPriorPlan` becomes a `render`.
- Definition reuse across both loops — one `prior-runs` definition, one `data-profile` definition, composed persisted for the conversation and unpersisted for the planner.

**Non-Goals:**

- Any change to the briefing contract, storage envelope, pinned-prefix loading, or card surface — this change only adds definitions and composition sites.
- Injecting run findings, synthesis content, or step summaries anywhere (explicitly excluded by the hard constraint).
- Refreshing/superseding the prior-runs briefing mid-thread (standing briefings are immutable; see R1).
- Rolling-briefing retrofits (working memory, analysis context) — still follow-up work.
- Changing `inspect_run` itself.

## Decisions

### D1: prior-runs is an index, never a digest

Per run, exactly: run id, plan title/question, completion timestamp, step outcomes as `n/m steps completed` plus failed step names — at most ~2 rendered lines. No synthesis body, no step-summary text, no findings. The briefing ends with a fixed nudge that details are retrievable via the `inspect_run` tool (which returns the `summary.md`/`synthesis.json` paths for `read_file`). Rationale: the pull-only result model is a deliberate prior decision; the briefing's job is to make the agent *know to pull* (and the planner to plan around what already ran), not to pre-pay tokens for bodies that are one tool call away. It also keeps the pinned prefix small — briefings ride every turn of every thread. *Alternative considered*: including one-line step summaries or synthesis key findings — rejected; it violates the hard constraint, bloats the immutable prefix, and duplicates what `inspect_run` + `read_file` already serve just-in-time.

### D2: A run-index reader in `src/state/`, pure render over its output

`render` must stay pure, so the I/O lives in a new reader, `loadRunIndex(pool, analysisId)` in `src/state/run-index.ts`: `queryRunsByAnalysis` (`cortex_runs`), filtered to terminal statuses, plus `queryStepsByRun` (`cortex_step_executions`) per indexed run for step outcomes, plus the plan `title`/`analytical_narrative` via `loadPlan` for runs with a `planId` (title facet; narrative truncated as fallback for pre-title plans). It returns the typed `PriorRunsInput` the definition renders — and it only fetches steps/plans for the runs that will actually render (the cap applies at the reader, the count of older runs rides in the input). *Alternative considered*: rendering from `CortexRunRow[]` directly inside the definition — rejected; the definition would need pool access (impure) or the composition sites would each re-implement the join.

### D3: Terminal runs only — completed, partial, failed, canceled

A running run is volatile; pinning "run X is in progress" into an immutable prefix guarantees staleness within minutes. Terminal outcomes are facts that stay true. In-flight runs already have live surfaces (run-event stream, dag-state parts, `inspect_run`). Failed/partial/canceled runs are included deliberately — "what was tried and how it ended" is exactly the awareness the planner needs to avoid repeating a failed approach.

### D4: Hard caps with explicit truncation — 10 most recent runs, ~2 lines each

The index lists the 10 most recent terminal runs (recency order, newest first). When more exist, one explicit closing line — `…and K older runs` — makes the truncation visible; silent truncation would let the model believe the index is exhaustive. The caption compresses to at-a-glance provenance: `2 prior runs · latest run_8f3a 6/7 steps · 2026-07-10` (count, latest run id + step outcome, latest completion date). Timestamps use the same minute-precision convention as the data-profile caption.

### D5: Omit-on-missing means "no terminal runs → no briefing"

An analysis with zero terminal runs composes no prior-runs briefing — never a "no runs yet" placeholder (a standing briefing is immutable, so the placeholder would pin a forever-false statement into threads created before the first run). This is the same rule the shipped spec sets for an unavailable data profile. Consequence (accepted, matches shipped R4/D7): a thread started before the first run never gets a prior-runs prefix; the run's completion reaches it via the normal conversation flow and `inspect_run`.

### D6: Main-conversation order is [data-profile, prior-runs]

`composeStandingBriefings` in `src/app/chat-turn.ts` appends the prior-runs briefing after data-profile — data before history, and existing threads' persisted prefixes (data-profile only) remain valid order-prefixes of the new composition. Each composes independently: a missing profile with existing runs yields `[prior-runs]` alone. Persistence, idempotent append, and card surfacing are untouched machinery.

### D7: prior-plan is a `BriefingDefinition`, serialized from the stored plan

`formatPriorPlan` (narrative, one `- **id** (agent): name — question [deps]` line per step, and the preserve-step-IDs iteration guidance) moves verbatim-in-spirit into a `prior-plan` definition whose input is `{ planId, plan }` parsed from `loadPlan` output. Mode is standing — it is start-of-loop context, not per-turn tail state — but its only composer today is the planner, which uses it unpersisted. Caption names the planId and step count (e.g. `iterating pln-1a2b3c4d · 7 steps`). It is NOT composed in the main conversation.

### D8: Planner composes briefings as unpersisted initial messages; the user message stays the ask

`generate_plan` builds the planner's initial message array as `[...briefings.map(b => b.message), userMessage]` where briefings are, in order: data-profile (from `loadDataProfileStatus`, omitted unless completed), prior-runs (from `loadRunIndex`, omitted when empty), prior-plan (only when `parentPlanId` is set, loaded via the existing `loadPlan` path with its existing fail-fast error handling). The user message keeps exactly the research question and user constraints — the ask, which genuinely originates with the caller. Nothing is persisted and no briefing cards are surfaced (ephemeral sub-agent transcript, per the shipped D10). The planner prompt's context expectations update to name the `<briefing>` blocks.

### D9: `generate_plan` drops `dataContext` and `priorRuns` from its input schema (BREAKING)

The harness reads its own state instead of trusting the conversation agent's paraphrase: the profile and run history now come from the ledgers at composition time — fresher, complete, and not token-taxed through a tool call. Remaining inputs: `researchQuestion`, `userConstraints?`, `parentPlanId?`. The conversation agent's prompt guidance for `generate_plan` updates accordingly. *Alternative considered*: keeping the params as optional overrides — rejected; two sources of truth for the same context invite divergence, and the params exist only because the tool previously had no other way to see that state.

### D10: Reuse, not duplication, is the acceptance bar

The same `dataProfileBriefing` and `priorRunsBriefing` values are composed by both `chat-turn.ts` and `generate-plan.ts` — no planner-specific variants, no re-rendering logic. Anything the planner needs that the main conversation doesn't (prior-plan) is a separate definition, not a fork.

## Risks / Trade-offs

- **[R1: Standing immutability makes the run index stale within a long thread]** — a thread briefed with 2 runs still shows 2 after run 3 completes. → Mitigation: the briefing's closing nudge points at `inspect_run` as the live source; run completion reaches the conversation through the normal flow; new threads and every planner invocation re-read the ledger. This is the shipped no-supersede semantics, accepted knowingly.
- **[R2: Reader fan-out]** — `loadRunIndex` issues 1 + up-to-10×(steps + plan) queries on first turns and every planner call. → Mitigation: the cap bounds it, ledgers are thin and indexed by run id, and the reader fetches only for rendered runs; measured as negligible against the LLM call it precedes.
- **[R3: Ephemeral runs pollute the index]** — `cortex_runs` also records `run_ephemeral` workflow runs, which have no plan and often no steps. → The index includes them (they are real history) but their line degrades gracefully: workflow name stands in for the missing plan title, `0/0 steps` is rendered as step-less. If they prove noisy the reader can later filter by `workflowName` without touching the definition.
- **[R4: Breaking the `generate_plan` schema mid-flight]** — prompts or tests still passing `dataContext` would fail Zod validation at the tool boundary. → Mitigation: single change updates schema, conversation prompt guidance, and tests together; the boundary failure mode is a model-visible error tool result, not a crash.
- **Trade-off**: prior-runs persisted per thread duplicates index text across threads — same verbatim-persistence trade the briefing system already made for auditability.

## Migration Plan

Purely additive on storage (no new envelope kinds, no schema change). Code lands in one change: definitions + reader first (independently testable), then the chat-turn composition, then the planner migration (schema + prompt + assembly together, per R4). Rollback is reverting the code; threads briefed with prior-runs keep their persisted rows harmlessly.

## Open Questions

- Whether `run_ephemeral` rows should be filtered out of the index from day one (R3) — current answer: keep them, degrade gracefully; revisit with real transcripts.
- Exact truncation length for the plan-narrative fallback in a run's title facet — pick during implementation with fixture snapshots as the review surface.
