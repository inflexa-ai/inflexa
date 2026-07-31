## Context

`llm_usage` (migration 3) stores `record_key, recorded_at, agent_id, call_path, scope_kind, scope_id, thread_id, run_id, step_id, requested_model_id, served_model_id` plus five nullable token columns, with one index on `(scope_kind, scope_id)`. Three read functions exist, all analysis-grain: `getAnalysisUsageTotals`, `listAnalysisUsageByModel`, `listAnalysisUsageByAgent` (`src/db/primary_query.ts:351-385`). The sidebar's USAGE section renders the analysis figures and, unlike DATA PROFILE (`sidebar.tsx:506`) and RUNS (`:513`), passes no `onActivate`.

How a call is attributed follows from where it ran, and this is what makes the grains disjoint rather than nested: a chat turn's session carries `threadId` in scope (`turn.ts:132`), so its rows have `thread_id` set and `run_id` NULL; a call inside a run carries a `RunFrame`, so its rows have `run_id` (and `step_id` inside a step) and no `thread_id`. Every row of either kind carries the analysis in `scope_id`.

The dialog subsystem already provides the shell, the stack, and the list primitives, and every dialog is showcased in the design gallery.

## Goals / Non-Goals

**Goals:**
- Answer "what did this cost" at the session, run, and step grains, in the TUI.
- Keep every surface readable with the durable engine stopped, matching the section that launches it.
- Reuse the existing dialog and list primitives rather than inventing a surface.

**Non-Goals:**
- Per-message persistence across a reload (harness-first; see Decision 6).
- Pricing or currency — still tokens only.
- Any schema change, new index, or change to the recorder.
- Cross-store joins to name runs (Decision 3).

## Decisions

### Decision 1: The four grains are disjoint, and a session excludes the runs it launched

A session's figures cover its chat turns only. A run launched from that conversation is reported under the run, not folded into the session.

*Why:* attribution follows the frame the call actually ran in, which is what the ledger records — a run-frame call has no `thread_id` to sum under a session even in principle. Folding runs into their originating session would also double-count the moment both grains are on screen together, which they are in this dialog. And it could not be computed offline: the thread→runs relationship lives in the harness's Postgres (`cortex_runs.thread_id`), so a "session including its runs" figure would break the property that makes this surface worth having — that it opens with the engine cold.

*Consequence, accepted:* a user who launched a large run from a chat sees a small session figure beside a large run figure, rather than one combined number. The dialog therefore shows the analysis total as the headline, which IS the sum over everything; the grains below it partition that total by where the work happened.

*The partition needs a third bucket to actually close.* A call can carry neither a thread nor a run — background and boot-time work runs under an analysis scope without either — so session-plus-run does not necessarily reach the headline. Those calls get an explicit unattributed group rather than being dropped: a figure present in the total and absent from every part below it reads as a ledger defect, and the whole point of showing grains is that they add up.

*Alternative considered:* nesting runs under their session, with the harness pool consulted when ready. Rejected on the offline property and on double-counting.

### Decision 2: One dialog with grains side by side, not four commands' worth of screens

The sidebar's USAGE section gains `onActivate`, opening a single usage dialog: the analysis headline, then breakdowns by session, run, model, and agent, with a run drilling into its steps.

*Why:* this is the affordance the sidebar already teaches — DATA PROFILE and RUNS both open detail flows from their section, and a user who has learned that reaches for it on USAGE too. It also keeps the comparison in one place, which is the actual task: "which of these spent the tokens" is a question about the set, not about one member, so four separate screens would make the user hold figures in their head.

Steps hang off a run rather than being a top-level grain: a step id is only meaningful within its run, and a flat step list across runs would sort unrelated work together.

### Decision 3: The id is the identity and is always shown; a name is additional, never a replacement

Rows are identified by the six-character id tail `idTail` already produces (`src/tui/hooks/sidebar_live.ts:369`), extended on collision to the shortest distinguishing length. A known name is rendered beside the id, never instead of it.

*Why the existing helper:* one id must read identically wherever the app prints it, and the run surfaces already print this form. Minting a second shortening would give the same run two appearances and make a user compare labels that are not the same label.

*Why the id always stays:* names for runs live in the harness's Postgres, so whether one is in memory depends on boot state. If a name could replace the id, the same row would read differently on a cold open than a warm one — an identity that changes with unrelated state is not an identity. Keeping the id present makes the name pure decoration, which is what lets it be absent without consequence. Fetching is never attempted; that is the boot dependency Decision 1 exists to avoid.

*Why collisions are handled rather than assumed away:* six characters is 24 bits, so within one analysis a clash is unlikely but not impossible, and the failure mode — two different runs rendering one label in the same list — is silent and misleading. Extending only the colliding rows is git's abbreviation rule, and it costs nothing when there is no clash.

### Decision 4: Ordering is lexicographic over named quantities, never over a constructed total

Rows sort by input tokens descending, then output tokens, then call count.

*Why:* "order by spend" needs a single magnitude per row, and constructing one is exactly what Decision 10 of the ledger change forbids — cache counts are a breakdown of input, so any combined figure double-counts a cached prefix. A lexicographic order over the quantities as reported gives a deterministic, useful sort without inventing that number. Input leads because it is the quantity that dominates consumption in practice: a turn reporting 42.6k in and 40 out is a large consumer that an output-led sort would bury.

### Decision 5: The command grows subcommands, not flags

`inflexa usage` keeps its analysis report; the grains arrive as subcommands.

*Why:* the house rule is that an option which changes a command's effect class must be a subcommand, and the related rule keeps `safeFlags` small. These are all reads, so the effect class does not change — but the same instinct applies to the agent surface: each grain is separately classifiable, and a grain added later cannot silently widen an existing command's allowlist. It also keeps each subcommand's output shape fixed, which matters for a report an agent may parse.

Every grain remains read-only, so each takes the analysis selector's existing safe-flag treatment. The classification for each new subcommand is confirmed with the user before registration, per the house rule — the same gate the parent command went through.

### Decision 6: Per-message persistence is out of scope, and why it cannot be done here

A rollup shown on a finished assistant message does not survive reopening the transcript, and this change does not fix it.

*Why not here:* the fix needs a stable identity shared by the live message and its stored row, and the CLI has none. `startAssistantTurn` mints the live id locally (`conversation.ts:654`); `appendTurn` returns `ResultAsync<void, DbError>`, so the CLI never learns the id storage assigned; and a chat-path usage record carries `thread_id` but no message or turn id, because outside a `RunFrame` the harness mints a fresh UUID per call rather than a composed key. A CLI-side sidecar keyed by the live id would be orphaned on the next load — a fix that appears to work until you restart, which is worse than the honest gap.

The record shape and the thread store are both harness-owned, so this is harness-first by the repository's boundary rule. Tracked as its own change rather than worked around here.

## Risks / Trade-offs

- **A user reads the session figure as "everything this conversation cost"** and is surprised it excludes a run they launched from it. → Mitigated by the headline being the analysis total and by labelling the grains for where work ran rather than who started it. This is a wording risk, and the spec pins the vocabulary.
- **A run id is opaque**, so a breakdown row can be hard to recognise. → Mitigated by Decision 3's name-beside-id when the runs snapshot is loaded, and by Decision 4's ordering so the largest consumer is at the top regardless of its label.
- **The dialog's queries scan by `run_id`/`thread_id`, which carry no index** — only `(scope_kind, scope_id)` does. → Accepted: every query is already constrained to one analysis, so the index does the selective work and the group-by runs over that analysis's rows. Adding indexes for a table this size would be cost without a reader, which is the same reasoning that kept migration 3 to one index.
- **Grain rows whose figures are all absent** (a provider that reported nothing) could read as zero-cost work. → The spec requires the absent vocabulary the existing surfaces already use, and the call count is shown beside the figures so a row is never mistaken for having done nothing.
