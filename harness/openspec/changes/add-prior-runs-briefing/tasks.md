# Tasks: add-prior-runs-briefing

## 1. Run-index input reader

- [x] 1.1 Add `src/state/run-index.ts`: `loadRunIndex(pool, analysisId)` — terminal runs from `queryRunsByAnalysis` (`cortex_runs`), step outcomes from `queryStepsByRun` (`cortex_step_executions`), plan title/narrative facet via `loadPlan`; applies the 10-run cap at the reader and returns the typed `PriorRunsInput` (indexed entries + omitted-older-run count); export from `src/state/index.ts`
- [x] 1.2 Add reader tests (Postgres testcontainer via `withSchema`): terminal-only filtering, newest-first order, cap + older-count, step-outcome aggregation, plan-less (`run_ephemeral`) rows degrading to workflow name, empty analysis returning an empty input

## 2. Briefing definitions

- [x] 2.1 Add `src/prompts/briefings/prior-runs.ts`: `priorRunsBriefing` (`mode: "standing"`, pure `render`) — per-run index entry (run id, title/question, completion timestamp, n/m step outcomes + failed step names, ≤2 lines), explicit `…and K older runs` line, closing `inspect_run` nudge, caption `N prior runs · latest <id> n/m steps · <date>`; export from `src/prompts/briefings/index.ts`
- [x] 2.2 Add `src/prompts/briefings/prior-runs.fixture.ts` (mixed statuses, a failed step, an over-cap variant) and `prior-runs.test.ts`: snapshot of content + caption, no-synthesis/no-summary assertion, nudge-is-last-line, cap/truncation-line cases, determinism, `mode === "standing"`
- [x] 2.3 Add `src/prompts/briefings/prior-plan.ts`: `priorPlanBriefing` (`mode: "standing"`, pure `render` over `{ planId, plan }`) migrating `formatPriorPlan` — narrative, one line per step (id/agent/name/question/deps), preserve-step-IDs guidance; caption `iterating <planId> · N steps`; export from the barrel
- [x] 2.4 Add `src/prompts/briefings/prior-plan.fixture.ts` and `prior-plan.test.ts`: snapshot of content + caption, per-step line shape, guidance presence, determinism

## 3. Main-conversation composition

- [x] 3.1 In `src/app/chat-turn.ts` `composeStandingBriefings`: load the run index via `loadRunIndex` and compose `priorRunsBriefing` after `dataProfileBriefing` (array order data-profile, prior-runs); omit when the analysis has no terminal runs; independent omission (profile-less analyses still get prior-runs)
- [x] 3.2 Add/extend chat-turn tests: first turn with profile + runs persists both briefings in order and surfaces two briefing cards; no-runs analysis injects no prior-runs row; runs-without-profile injects prior-runs alone; existing threads (pre-briefed with data-profile only) are not recomposed

## 4. Planner migration

- [x] 4.1 In `src/tools/research/generate-plan.ts`: drop `dataContext` and `priorRuns` from the input schema (keep `researchQuestion`, `userConstraints?`, `parentPlanId?`); delete `formatPriorPlan` and the hand-built prompt concatenation
- [x] 4.2 Build the planner's initial messages as `[...composed briefing messages, user message]`: data-profile from `loadDataProfileStatus` (omit unless completed), prior-runs from `loadRunIndex` (omit when empty), prior-plan from the existing `loadPlan` fail-fast path when `parentPlanId` is set; user message carries research question + user constraints only; nothing persisted, no briefing cards
- [x] 4.3 Update the `generate_plan` tool description and the conversation prompt's plan-generation guidance (`src/prompts/conversation.ts`) to the new input surface; update the planner prompt (`src/prompts/planner.ts`) to reference the `<briefing>` context blocks
- [x] 4.4 Update/extend generate-plan tests: initial-message composition order (briefings then ask), omission cases, invalid `parentPlanId` still fails fast, terminal-outcome flow unchanged; remove `dataContext`/`priorRuns` from all fixtures and callers

## 5. Verification

- [x] 5.1 `tsc -p tsconfig.json` passes
- [x] 5.2 `bun test` passes (including new snapshots committed)
- [x] 5.3 `bun run format:file` on every changed file under `src/`
- [x] 5.4 `openspec validate "add-prior-runs-briefing"` passes
