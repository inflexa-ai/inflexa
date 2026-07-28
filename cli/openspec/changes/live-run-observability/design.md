## Context

Run observability in the TUI has three surfaces today: the sidebar RUNS section (3 rows, plus a `RunBlock` embed under the *newest* non-terminal run), the runs picker → run-detail dialog, and the inert `RunCardPart` in the transcript. All of them read a five-second poll of `cortex_runs` / `cortex_step_executions` (`sidebar_live.ts`), because the harness's run-event stream has no OSS reader.

Two prior decisions are being revisited deliberately, not rediscovered:

- **`2026-07-14-rework-run-display` D7** accepted "hidden sidebar means no live progress" as an explicit user decision, and deleted `run_progress_row.tsx`. Field evidence (#244, #241) now argues against it. The new panel is not that row rebuilt: the old row duplicated the rail's content, and this one holds what the rail physically cannot.
- **`sidebar-live`** makes a correctness argument out of the single-slot snapshot: "the snapshot is always the newest run's… so no run-row/progress mismatch is representable." Keying by run id has to re-earn that guarantee rather than discard it.

The measured constraint that shapes the panel: `size.railWidth` is 40 and `size.railStepRows` is 7 (`design_system.ts:732,751`). A rail step row is already `glyph + stepId + age`; adding a human name, an agent id, and an activity string is 60+ characters and does not fit at any tuning.

## Goals / Non-Goals

**Goals:**
- Name the work: a reader can tell what a run is and what step is executing, in words.
- Make the terminal edge impossible to miss, whether the user is watching, elsewhere in the app, or away entirely.
- Make concurrent runs — including runs of different plans — fully visible and navigable.
- Preserve the refresh loop's existing correctness properties: generation tokens, poll-skip, and idle-costs-nothing.

**Non-Goals:**
- Reading the DBOS `"events"` stream, or any of its eleven workflow-emitted parts (#247).
- Waking the agent when a run lands (#248). The thread record makes the outcome *visible* to the next turn; nothing initiates one.
- A unified "all background work" model. Sandbox pulls and reference/GEO downloads keep their own channels.
- Aborting a run from the TUI (#250). It was scoped in and extracted: making cancellation terminal is a run-lifecycle decision in the harness, not a UI affordance.
- Sub-step detail inside the run panel beyond a single derived activity label.

## Decisions

**D1 — Rail owns structure; panel owns the frontier.** The rail answers *what is the shape of the work* — every active run, its steps, their states. The panel answers *what is happening right now* — one focused run, its frontier step in full, its agent, a live activity label, elapsed, and controls. The only overlap is the completion count, rendered as a meter in the rail and as bare text in the panel so the two do not read as the same widget twice. Rejected: moving the step list out of the rail into the panel, which the user rejected outright — the rail's block is useful and clickable. Rejected: making the panel a second step list, which would be a literal duplicate at a different width.

**D2 — The active-run snapshot becomes a map keyed by run id, and the mismatch guarantee is re-earned structurally.** Today the guarantee comes from there being exactly one snapshot, cleared when the newest run goes terminal. With N snapshots the guarantee comes from the key: a block renders under the run row whose id it is keyed by, so attributing one run's steps to another is not representable. The existing failure-path rule generalizes unchanged — a step read that fails keeps the previous entry only when it belongs to that same run id, and drops it otherwise.

**D3 — Push and poll coexist; push is a trigger, not a data source.** The harness observation callback lands as a `run.*` bus event, and the TUI's handler pokes the same `refreshSidebarData` the lifecycle edges already poke. The snapshot payload is deliberately *not* rendered directly. Two reasons: the refresh already owns the generation-token ordering and the plan-title join, and a push-rendered path would be a second way for the store to be written, with its own staleness rules. Polling stays as the backstop for anything the callback misses (a run started by another process, a callback dropped during boot) and keeps its arming condition, so idle still costs nothing.

**D4 — `run.*` is a distinct event family from `prov.*`.** One bus, separated by type string, per the project's bus rule. Provenance events close a signed hash chain guarded by a single-writer instance lock; run observation is a cosmetic channel that tolerates loss. Reusing `prov.run_completed` to drive UI would couple a repaint to the chain's write discipline and force provenance to carry step names and agent ids it has no reason to record.

**D5 — The completion record is a harness synthetic message, not a local part.** The live transcript is harness-backed: `loadMessages` reads `runtime.pool`, and the SQLite `messages`/`parts` tables are frozen legacy with no writer. A synthetic message is the right vehicle because it opens no turn — excluded from turn grouping, the token window, and the retraction cut point — so it can land between turns without corrupting structure. It also means the outcome is in the thread the next turn assembles context from, which makes the agent's "I'll check when it completes" answerable without a tool call. Accepted consequence (owned by the harness spec): a notice folds into the preceding turn and is removed if that turn is retracted.

**D6 — The card settles; it neither freezes nor hides.** Hiding was considered and rejected: run cards are reconstructed on transcript reload, so a hidden card erases the launch from history, and a widget disappearing to mean "done" is the precise defect #241 reports. Freezing a stale progress meter in scroll-back is also wrong. Settling — live chrome collapses, a compact outcome line remains — is the same lifecycle `ToolBlock` already implements (`running` → `✓ ok · 14ms`), one level up. The card resolves its state by looking itself up by the `runId` it already carries, so no new persistence is required and a reloaded transcript settles correctly from the ledger.

**D7 — The toast channel becomes a FIFO queue that discards nothing.** `notify` is documented as single-slot precisely to avoid a queue ("a new notice overwrites the showing one"). That is right for user-initiated feedback and wrong for unsolicited completions, where two runs landing within the dismiss window would silently drop one — reintroducing #241. A bound was considered and rejected: concurrency here is capped by how many runs one analysis can have in flight, which is small, so there is no realistic burst to protect against and a drop policy would be machinery guarding an impossible case.

**D8 — Durable reactions dedupe by `(runId, terminal status)`.** The harness fires the observation callback outside `DBOS.runStep` so recovery re-fires it. Snapshots are idempotent for rendering, but the toast and the thread append are side effects and are not. The handler therefore keys them, exactly as `agent_switch`'s work gauge already keys `enterWork`/`leaveWork` by `run:<runId>` for the same reason.

**D9 — Sub-agent activity is one line on the parent tool block.** A sub-agent runs *inside* a tool call, so the block that represents it is already on screen with a `running` state and a duration on completion. A single muted line showing the innermost activity (selected by `callPath` depth) turns a silent long tool call into something legible with no new block kind and no flood. `isSubAgentEvent` is not deleted — it stops being a discard and becomes the routing predicate that directs an event to its parent block instead of the transcript root. Rejected: a full nested transcript (buries the conversation) and a separate pane (a third place to look).

**D10 — Panel navigation mirrors existing idioms.** A leader chord cycles focus between active runs and the section is mouse-clickable, matching the rail's existing click-to-open behaviour; the panel toggle is both a keybinding and a palette command, mirroring how the sidebar toggle is exposed. Auto-advance on terminal keeps the panel showing live work rather than a finished run — the settled card and the thread record are the record by then, so the panel has nothing left to say and empties itself when no active run remains.

**D11 — The panel is fixed chrome directly below a `flexGrow` scrollbox, so it must be a full-width box painted with the panel background.** This is the documented scrollbox-bleed rule, not a precaution: a `flexGrow` scrollbox renders one row taller than it contributes to the column, and a bare `<text>` below it leaves stream content showing through the gaps. It also needs `flexShrink={0}`, since a non-numeric width defaults to shrinking and would collapse the panel below its own border on a short terminal. Verified with the height-sweep harness, because these bugs are size-dependent and a single size hides them.

**D12 — Durable thread writes serialize, and the loser queues rather than drops.** Belongs with D5. `ThreadHistory` documents that "callers are assumed single-writer per thread (the host serializes turns)", so a run-outcome append landing inside an unwinding turn would splice a message between that turn's rows. The gate runs both ways: a user message submitted during an append is queued and its turn begins after, and a run terminating mid-turn defers its append until the turn's own append completes. Deferring costs the user nothing because the toast fires immediately regardless — only the durable record waits.

This deliberately does **not** reuse the generation token from `tui-harness-chat`, whose contract is that "the newest store-writing operation to have *started* wins; any older one SHALL drop silently". Drop-the-loser is right for UI writes, where the newest render supersedes. It is wrong here: a user's message and a run's outcome are both durable, and discarding either to favour the other loses real content. Rejected alternative: refusing the user's keystroke while an append is in flight, which trades a data-loss bug for a responsiveness bug.

## Risks / Trade-offs

- [Per-active-run step queries multiply the poll's cost — N queries per tick instead of one] → Bounded by concurrent runs, which is realistically one to three, and the arming condition is unchanged so an idle analysis still issues zero. The push trigger further reduces reliance on the interval.
- [The rail grows with the number of active runs and can outgrow a short terminal] → It already scrolls (`ScrollPane`), and the active-vs-terminal rendering rule keeps growth proportional to live work rather than to history.
- [Reversing D7 of the prior change reintroduces a surface that was deliberately deleted] → Reversed knowingly and on field evidence, and with a different content contract: the deleted row duplicated the rail, this one holds what the rail cannot fit.
- [A settled card in a long transcript is far above the user's attention when the run lands] → That is exactly why the thread record is appended at the moment of completion; the two are complementary, not redundant.
- [A malfunctioning or replaying observer could append duplicate thread records] → D8's keying, plus the fact that the append is host-side and single-writer per thread.
- [Naming steps requires resolving the plan, which the picker's join does per plan id with a known batching TODO] → Same join, same caveat; the resolution is cached per plan id within a refresh so a rail with several runs of one plan reads it once.
- [Sub-agent lines could still be noisy for a deeply nested agent] → Only the innermost activity is shown, one line, and only while the parent is running.

## Migration Plan

No data migration: no CLI schema change, and every new read is against existing harness ledger columns. The change is inert without the harness seams — the observer bus family simply never fires and polling carries the load — so it degrades to today's behaviour rather than breaking. Rollback is revert.

## Open Questions

None. Panel-versus-rail division, navigation model, auto-advance, the settle-not-hide decision, the dual announcement, the sub-agent presentation, and the scope boundary at profiles-and-runs were all settled with the user during exploration.
