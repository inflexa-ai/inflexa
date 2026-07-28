## Why

A run is the longest and most consequential thing the product does, and it is the least observable surface in the TUI. Issue #244 asks to know "how the jobs were running, where they were at, what progress had been made, and what tasks were being worked on"; issue #241 reports never noticing that a run completed or failed. Both are true of the current build, and the causes are structural rather than cosmetic:

- **The rendering pipeline is a lossy funnel.** `StepExecutionRow` carries sixteen fields and seven statuses; `RunStepView` carries three fields and four display buckets, labelled by `stepId`. A `blocked` step renders identically to a crash with its `blockedReason` discarded; a `skipped` step is indistinguishable from one still waiting. Meanwhile `shortRunName` returns `workflowName`, which is `"executeAnalysis"` on every row — so the rail deliberately shows a six-character id tail instead. The plan holds a title and every step holds a human name and an owning agent, one join away; the runs picker already performs that join.
- **Completion is signalled by an absence.** The progress embed disappears when the run terminates. That is the whole announcement, and it only happens where a user is already looking.
- **The transcript record is inert.** `RunCardPart` carries `{runId, title, stepCount}` and never gains a status, so the launch is recorded and the outcome never is.
- **Only one run is ever visible.** The active-progress snapshot pins the *newest* run; a second concurrent run has no live surface at all.

Beneath a running step, the same blindness repeats one level down: `isSubAgentEvent` discards every event whose `callPath` is deeper than one, so a planner or literature-reviewer working inside a tool call is forty seconds of silence.

## What Changes

- **The sidebar RUNS section shows every active run, not just the newest.** Each active run renders its own `RunBlock` — meter, `done/total`, and the bounded step window — while terminal runs stay one-line rows. The rail already scrolls, so its length tracks actual work. The single-slot active-run snapshot becomes keyed by run id.
- **The rail names the work.** Runs are labelled by their plan title and steps by their plan-assigned name (both joined CLI-side, as the runs picker already does), with the owning agent shown per step. `blocked` gains its reason, `skipped` becomes distinguishable from `pending`, and a retried step shows its attempt count.
- **A new sticky run-activity panel** sits between the stream and the input: one focused run at a time, at chat width — the frontier step in full, its agent, a live activity label, elapsed, and the run's controls. It is dismissable and restorable, navigable between concurrent runs by chord and by click, and auto-advances when the run it is showing terminates. It deliberately does **not** repeat the rail's step list: at `size.railWidth` (40 columns) a step row cannot carry a name, an agent, and an activity string, and the panel exists precisely to hold what does not fit.
- **Run lifecycle arrives by push, not only by poll.** The harness's new run-observation callback is realized at the composition root as a **`run.*` bus event family** — distinct from the `prov.*` provenance events, which stay provenance-only. Polling remains the backstop, and the idle-costs-nothing property is preserved.
- **Terminal transitions are announced twice, on purpose.** A **queued** toast fires at the moment a run lands — the existing single-slot `notify` overwrites a showing notice, which with concurrent runs would silently drop one completion, so it gains a FIFO queue that discards nothing. And a durable record is appended to the conversation thread as a harness synthetic message, which lands at its true chronological position, survives reload, and is visible to the agent on its next turn.
- **The run card settles rather than freezing or vanishing.** While its run is live the card carries progress; when the run terminates the live chrome collapses to a compact outcome line. It is deliberately not hidden: run cards are reconstructed on transcript reload, so a card that disappeared would leave the launch with no trace in history, and "signal by vanishing" is the exact defect #241 reports.
- **Sub-agent activity surfaces as one live line on its parent tool call.** A running `ToolBlock` shows the innermost sub-agent's current activity and drops it on completion — no new block kind, no transcript flood. This is the same idiom as the panel's activity line and the settling run card: a long-running thing states what it is doing on one line, and the line goes away when it finishes.

Scope is **runs and data profiles only** — they share the ledger, the refresh loop, and the workflow-step reader. Sandbox image pulls and reference/GEO downloads have their own `Result`-returning progress channels and are out of scope.

## Capabilities

### New Capabilities

- `run-activity-panel`: the sticky frontier panel — its content contract, multi-run navigation and auto-advance, dismiss/restore, and its degraded state.
- `run-completion-notice`: the terminal-edge announcement — the queued toast and the durable thread record, and how both stay correct under replay re-emission and concurrent runs.

### Modified Capabilities

- `sidebar-live`: per-active-run progress blocks instead of a single newest-run embed; a keyed multi-run snapshot; plan-title and step-name resolution; the unfunneled step fields; push-fed refresh with polling retained as the backstop and idle cost unchanged.
- `tui-stream-blocks`: the run card becomes live and settles to a compact outcome; the tool block carries a sub-agent activity line while running.
- `chat-view`: a harness synthetic message renders as an event block rather than a user turn.
- `event-bus`: the `run.*` event family, sourced from the harness observation callback and kept distinct from `prov.*`.
- `tui-layout`: the chat shell composition gains the sticky panel between the stream and the input.
- `key-bindings`: chords for panel navigation and dismiss/restore.

## Impact

- **New TUI surface**: the activity panel and its design-gallery exhibits. Every state it can express (no active run, one run, several runs, terminal-and-auto-advancing, dismissed, degraded) becomes a gallery exhibit — the gallery is the source of truth for TUI surfaces.
- **`src/tui/hooks/sidebar_live.ts`**: the snapshot becomes keyed by run id; the refresh gains plan resolution and the wider step projection; the observer push becomes a refresh trigger. The generation-token discipline and the poll-skip rule are unchanged.
- **`src/tui/hooks/notice.ts`**: single slot becomes a FIFO queue.
- **`src/modules/harness/`**: a run-observer realization beside `prov_bridge.ts`'s provenance emitter, injected at the same composition root; the thread append for the completion record.
- **`src/types/events.ts`**: the `run.*` members.
- **`src/tui/components/`**: `run_card_block.tsx` (live + settled), `tool_block.tsx` (activity line), `run_block.tsx` (the wider step projection).
- **Depends on** the harness change `add-run-observation-seams` for the observation callback and the public synthetic-message primitives. Everything else in this change is CLI-side.
- **Not touched**: the DBOS `"events"` stream (issue #247), autonomous agent wake-up (issue #248), aborting a run from the TUI (issue #250 — the `RunBlock` footer keeps advertising `esc detach · ctrl+c abort` in the gallery while no live mount wires it), the provenance chain and its single-writer lock, and the frozen legacy SQLite `messages`/`parts` tables — the live transcript is harness-backed.
