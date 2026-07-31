## Why

The ledger already records every discriminator needed to answer "what did this cost" at four grains — `scope_id` (analysis), `thread_id` (session), `run_id`, `step_id` are all columns on `llm_usage` — but only the analysis grain has a read path or a surface. The other three are reachable today only by opening the SQLite file by hand, which is not a product.

A token figure is most useful where the work is: which conversation ran up the bill, which run, and which step inside it. That is also the shape of the original question behind #243 — not "how many tokens exist" but "where did they go".

## What Changes

- **Three new read paths over the existing table**: per session (thread), per run, and per step within a run. No schema change — every column they group by is already stored and indexed by scope.
- **A usage dialog in the TUI**, opened by clicking the sidebar's USAGE section — the affordance DATA PROFILE and RUNS already use. It shows the analysis headline, then its breakdowns — by session, by run, by served model, by agent, plus an explicit group for work belonging to neither a session nor a run — and drills from a run into that run's steps. No new keybinding: the section click is the taught affordance, and a chord can be added later against the live keymap.
- **`inflexa usage` gains the same grains**, as subcommands rather than flags, so each keeps its own read-only classification and the report stays greppable.
- The dialog reads the local ledger only, so it opens with the durable engine stopped, like the section that launches it.
- **Unchanged**: the ledger's schema, the recorder, and the rule that no surface sums the five quantities.

## Capabilities

### New Capabilities
- `usage-breakdown`: the session/run/step read paths over the local ledger and the TUI dialog + command surfaces that present them, including what each grain means and how an unattributable or absent figure renders.

### Modified Capabilities

None. The two capabilities this builds on — `llm-usage-ledger` and the sidebar's USAGE section — are still unarchived deltas of `cli-token-usage-ledger`, so there is no main spec to write a delta against. The subcommand grains and the section's activation behaviour are therefore stated as requirements of `usage-breakdown`, which owns them outright rather than amending a sibling change in flight. Archiving order is the only coupling: `cli-token-usage-ledger` archives first.

## Impact

- **New**: read functions in `src/db/primary_query.ts`; `src/tui/components/dialog/usage_dialog.tsx` + its gallery exhibit; usage subcommand actions in `src/modules/usage/`.
- **Modified**: `src/tui/layout/sidebar.tsx` (the section gains `onActivate`), `src/tui/app.tsx` (the open handler), `src/cli/index.ts` (subcommand registration), the pinned agent-policy snapshots.
- **No schema migration.** Every grain groups by a column migration 3 already created.
- **Not in scope**: persisting a per-message token figure so it survives a transcript reload. That needs a stable message identity the CLI does not have — `appendTurn` returns `void`, and the live assistant message id is a locally-minted UUID that never reaches storage — so it is a harness-first change, tracked separately. This change deliberately does not work around it.
