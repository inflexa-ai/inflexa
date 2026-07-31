## Why

Token figures exist but are not where the reader is. Every entity the TUI already tracks — the conversation, the data profile, each run, each step — spends tokens, and none of them says so. Instead one dialog collects every grain into stacked tables, so answering "what did this step cost" means leaving the thing you are looking at, opening a panel, and finding it in a list.

Three concrete defects make that worse rather than merely inconvenient:

- **The rail's figure is stale exactly when it matters.** The USAGE section re-reads on the conversation's message count, which advances when the assistant bubble is CREATED (`hooks/conversation.ts:653`), not when the turn finishes — so it renders a figure from before the turn's calls were recorded. The current `sidebar-live` requirement states that count "advances when a turn completes", which is not true of the code it describes. Past `MESSAGE_CAP` (200) the store's push-and-shift leaves the length unchanged, and the section stops refreshing at all.
- **The data profile's spend is unreadable.** It is recorded — the harness stamps `run_id = "data-profile"` (`tasks/data-profile.ts:66`) — but that literal has no `cortex_runs` row, so it groups under "By run" as an undecorated id tail (`rofile`) beside real runs the Runs picker does not list. Two different kinds of thing share one column and one grouping.
- **The rail's headline answers a question nobody asked.** It reports the whole analysis while every other section reports the open working context. In a real ledger the conversation and the run it launched are 820.3k tokens and the background profile is a further 55.5k — a distinction the rail currently flattens.

## What Changes

- **Every entity that spends tokens displays its own spend.** The data-profile section and its detail dialog, each run row and the run detail dialog, each step in the run block, and the session — each carries its figure where it already carries its other properties.
- **The sidebar USAGE section becomes the SESSION's spend, detailed.** Input with cache write/read nested beneath it, and output. Scoped to every call stamped with the open thread, the runs it launched included — the containment reading, because reporting the conversation's own 11.1k moments after it launched a run that burned 809.2k is a lie by omission.
- **USAGE refreshes on a clock and on turn completion**, riding the bounded poll `sidebar-live` already arms while work is active rather than a second timer. **BREAKING (spec):** this reverses the current "SHALL NOT introduce a poll" and drops the message-count trigger, whose stated justification does not hold.
- **The data profile becomes its own grain**, partitioned out of the run grouping in the dialog and in `inflexa usage runs`, matching the rail where DATA PROFILE and RUNS are separate entities. The run id it is recognised by is imported from the harness, never written as a literal in the CLI.
- **The usage dialog narrows to by-model and by-agent for the current session.** Its by-session, by-run, and by-step tables are removed — those figures now sit on the entities themselves, which is where they were being looked for.
- **The analysis switcher's rows carry each analysis's total**, the one place an aggregate earns its keep, since that is where analyses are compared.
- **Two token-figure forms, chosen by surface:** a labelled `820.3k in · 43.3k out` where the figure is read — the rail's USAGE section, the usage dialog's headline, a chat turn's header, and the `usage` property line in the profile and run detail dialogs — and a compact `↑820.3k ↓43.3k` where it decorates a row in a list: the rail's profile and run rows, the run block's step rows, picker rows, grouping rows. Both are built by one module from the same quantities, both degrade to a single arm when only one was reported, and both are PAINTED by one component so no surface lays out its own arms.
- **A labelled figure puts its two arms at opposite edges of one row**, cache and reasoning quantities indented beneath their own arm. The rail's USAGE section stacked them, spending a rail row on a relationship that is not there, while the dialog headline gave each arm half the panel so the output figure floated mid-width adjacent to nothing.
- **Each step in the run-detail dialog carries its own figure**, matching what the rail's live run block already shows — a finished run reviewed after the fact must read the same as it did while it was running.
- **A turn's figure survives a transcript reload.** The rollup is persisted onto the turn's assistant message at append and read back on load. Without it, absence on that field means both "no provider reported anything" and "you reopened this conversation", and a reader cannot tell a measured-nothing turn from a reloaded one.
- **The chat turn's own LLM calls are recorded at all.** They never have been: `runAgent` reads its recorder from the options it is handed, and the conversation turn's call site omits it, so it silently falls back to the no-op. Only sub-agent and workflow loops have ever reached the ledger.
- **The sidebar MODELS section is deliberately NOT given figures.** Its rows map a role to a CONFIGURED model, while the ledger groups by what an endpoint SERVED; hanging served figures off role rows would silently fail to reconcile whenever a proxy substitutes.

## Capabilities

### New Capabilities

- `usage-figure-rendering`: how a token figure is written anywhere in the product — the labelled and compact forms and which kind of surface takes which, what an absent quantity renders as, and how the cache quantities nest under input rather than sitting beside it. It is a new capability rather than a note inside each surface because the whole point is that eight surfaces render the same quantities the same way, and a rule stated eight times is a rule that drifts.

### Modified Capabilities

- `sidebar-live`: the USAGE section is re-scoped to the session and detailed with the cache breakdown; its refresh moves to the bounded poll plus a turn-completion edge; the DATA PROFILE and RUNS sections and the run block's step views carry their own figures.
- `usage-breakdown`: the data profile becomes a grain distinct from runs; the dialog narrows to by-model and by-agent scoped to the current session; the grain partition rule gains the profile and states how it relates to the rail's containment reading.
- `command-palette`: the Switch analysis picker's rows carry each analysis's recorded total.
- `tui-layout`: `MessageBlock`'s prohibition on a meta footer ("that data is not tracked; fabricating it is NOT permitted") no longer describes the code — the turn's usage is tracked and rendered — and is corrected rather than left contradicting shipped behaviour.
- `llm-usage-ledger`: the seam-coverage requirement gains the term it was missing. Supplying the recorder at the composition root does not cover a `runAgent` call site that omits it from its options, and the requirement's coverage must be verified against the options the production path actually builds rather than against a substituted seam — which is why the conversation turn went unrecorded while a scenario asserting its coverage passed.

## Impact

- **Modified**: `tui/layout/sidebar.tsx`, `tui/hooks/sidebar_live.ts`, `tui/components/run_block.tsx`, `tui/components/dialog/run_detail_dialog.tsx`, `tui/components/dialog/usage_dialog.tsx`, `tui/layout/message_block.tsx`, `tui/hooks/conversation.ts`, `modules/harness/turn.ts`, `tui/commands.tsx`, `db/primary_query.ts`, `modules/usage/usage.ts`, and the design gallery's usage exhibits.
- **New**: `tui/components/token_figure.tsx` — the one component that paints a figure, in either form. `NOT_REPORTED` moves from `modules/usage/usage.ts` to `lib/usage_format.ts`: it is part of the NOTATION, and a component in `tui/components/` may not import a module.
- **New read paths**, all over columns already stored and already indexed by scope: a session's totals including its runs, a session's by-model and by-agent groupings, the data profile's totals, and per-analysis totals for the switcher.
- **Harness**: `DATA_PROFILE_RUN_LITERAL` (`tasks/data-profile.ts:66`) is module-private and must be exported for the CLI to recognise profile rows without a hardcoded string.
- **No schema change**: every quantity and grouping column this needs is already in `llm_usage`.
- **Harness rollup consumed**: the turn engine passes the rollup to `appendTurn` and the reload path carries the stored value back onto the message. The harness side (the `reported_usage` column, the write, the read-back) already shipped; this is the CLI wiring that makes it visible.
