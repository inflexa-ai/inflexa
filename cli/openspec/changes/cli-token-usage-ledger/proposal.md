## Why

The harness now emits a fully-attributed `LlmUsageRecord` for every completed LLM call (issue #243, harness change `token-usage-tracking`), but the CLI wires no realization of the `UsageRecorder` seam. Every record the harness produces is handed to `createNoopUsageRecorder` and dropped, so the question that opened the issue — *which request, run, step, and model spent my tokens* — still has no answer on the only surface a local user has. The harness half is merged and inert; this change is what makes it observable.

## What Changes

- **A local usage ledger.** A new SQLite table durably records one row per completed LLM call, keyed by the harness's `recordKey` and written with an upsert, so a replayed durable workflow body cannot double-count a call.
- **The seam is wired.** The CLI's composition root passes a `UsageRecorder` realization into `assembleCoreRuntime`, so every `runAgent` invocation — conversation turns, planner, sub-agents, analysis run steps — lands in the ledger.
- **The turn reports what it spent.** The shared turn engine surfaces what the whole turn consumed (sub-agents included) on its outcome, and the TUI renders it on the completed assistant message alongside the duration it already shows.
- **The sidebar gains a USAGE section** showing what the open analysis has consumed cumulatively, read from the local ledger.
- **A new read-only `inflexa usage` command** reports an analysis's consumption, broken down by served model and by agent.
- **Every surface reports input and output as two figures and never sums them.** The other three quantities the harness reports (cache reads, cache writes, reasoning) are breakdowns *of* those two, not additional amounts, so a single combined "tokens" number would double-count. No surface computes one.
- No pricing, no currency, and no cost estimation: this change records tokens. Converting tokens to money needs a per-model, per-token-class rate table — cache reads and fresh input bill at very different rates — which is its own decision and its own change. The ledger stores the served model id and each token class separately, which is exactly the input such a change would need, so this is a deferral with a path rather than an omission.

## Capabilities

### New Capabilities
- `llm-usage-ledger`: the CLI's realization of the harness `UsageRecorder` seam and the durable local ledger behind it — the record→row mapping, the idempotent write, the attribution columns, the read surface, and the `inflexa usage` report.

### Modified Capabilities
- `tui-harness-chat`: the shared turn engine (`src/modules/harness/turn.ts`) currently discards everything on `AgentFinish` except `reason`; it gains a turn-usage field on `TurnOutcome`, and the TUI conversation surface renders it on the finished assistant message.
- `sidebar-live`: the sidebar gains a fifth live section (USAGE) whose source is the local SQLite ledger rather than the harness's Postgres ledger — a deliberate departure from the section-sourcing rule that capability currently states, and one its requirements must therefore admit.

## Impact

- **New**: `src/modules/harness/usage_recorder.ts` (the seam realization), `src/modules/usage/usage.ts` (+ the `inflexa usage` action), one new migration version in `src/db/primary_migrations.ts`, read/write functions in `src/db/primary_query.ts` and `src/db/primary_mutation.ts`.
- **Modified**: `src/modules/harness/runtime.ts` (composition root), `src/modules/harness/turn.ts` (`TurnOutcome`), `src/tui/hooks/conversation.ts` (per-turn display), `src/tui/layout/sidebar.tsx` (USAGE section, and the stale comment recording that no accounting source exists), `src/cli/index.ts` (command registration).
- **Dependencies**: requires a harness build carrying the `UsageRecorder` seam (PR #276). No new third-party dependencies.
- **Data**: a forward-only migration adding one table. No existing table is altered, so the change is additive for an existing local database. The ledger lives in the CLI's local SQLite rather than the harness's Postgres, which keeps the report readable with the engine stopped and keeps the embedder out of harness-owned storage — at the cost that a wiped local database loses usage history, and that usage rows outlive an analysis that is deleted.
- **Not affected**: the harness's OTel counters, the run-event stream's usage parts (deliberately not consumed — see design), and the REPL chat printer.
