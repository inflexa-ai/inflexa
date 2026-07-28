## 1. Run-observation bus family

- [x] 1.1 Add the `run.*` members to `BusEvent` in `src/types/events.ts` — one member per run-lifecycle action, each carrying only the fields that action needs, no nullable-companion discrimination
- [x] 1.2 Add a run-observer realization beside `prov_bridge.ts`'s provenance emitter that maps the harness observation callback onto `run.*` bus emissions, sharing no code or payload with `createRunProvenanceEmitter`
- [x] 1.3 Inject the observer at the same composition root that supplies `emitProvenance` (`run_deps.ts`), keeping the provenance emitter untouched
- [x] 1.4 Test: a `run.*` subscriber receives run state without any `prov.*` event firing differently, and the provenance recorder's behaviour is unchanged
- [x] 1.5 Test: with no embedded run in-process (a run started elsewhere), no `run.*` event is observed and the change degrades to polling — deferred to group 2, where the sidebar store exists to assert the polling fallback against; in isolation this asserts only that an uncalled function emits nothing

## 2. Keyed multi-run snapshot in sidebar-live

- [x] 2.1 Change the active-run progress store in `src/tui/hooks/sidebar_live.ts` from a single slot to a map keyed by run id
- [x] 2.2 Fetch steps for **every** non-terminal run in the refresh, inside the existing generation-token guard; remove a run's entry when it goes terminal
- [x] 2.3 Resolve the plan title per run (falling back **directly to the id tail** — never to the workflow name, which is `"executeAnalysis"` on every row and so labels every unresolvable run identically) and the plan step name per step, caching by plan id so several runs of one plan read the plan once — reuse the runs picker's `loadPlan` join shape
- [x] 2.4 Widen the step view projection to carry the step name, owning agent, blocked reason, and attempt count; keep the status→view-state mapping defined once and shared with the run-detail dialog and the panel
- [x] 2.5 Make `skipped` distinguishable from `pending` in the view state rather than collapsing both to queued
- [x] 2.6 Subscribe the store to `run.*` as a refresh trigger only (never a data source), following the poll's skip rule rather than the lifecycle rule
- [x] 2.7 Verify the arming condition still disarms: an analysis with no active work issues zero queries and holds no interval
- [x] 2.8 Test: two concurrent runs each publish their own keyed entry; a terminal run's entry is removed while the other's survives
- [x] 2.9 Test: a step-read failure keeps a previous entry only when it belongs to the same run id, and drops it otherwise
- [x] 2.10 Test: an event burst arriving faster than reads complete still results in a completed refresh that writes

## 3. Sidebar RUNS section

- [x] 3.1 Render a `RunBlock` per active run under its own run row (heading suppressed, `maxSteps` capped to the rail token); render terminal runs as one-line rows, capped as today
- [x] 3.2 Label run rows by plan title and step rows by plan step name; the owning agent renders only in the WIDE mounts (run-detail dialog, gallery) — measured, the rail's ~37 usable cells cannot hold name + agent + age, and the tag pushed both off the row
- [x] 3.3 Surface a blocked step's recorded reason rather than a bare failure glyph, and show a retried step's attempt count
- [x] 3.4 Confirm the rail's scroll container absorbs the added height across a sweep of terminal heights
- [x] 3.5 Render tests: two active runs each show a block; a terminal run collapses to a row; names replace ids

## 4. Run-activity panel

- [x] 4.1 Build the panel in the layout composition kit: run label, completion count, elapsed, and the frontier step's name, agent, activity label, and running time — no step list
- [x] 4.2 Derive the activity label from the newest durable workflow step of the run family, reusing `readNewestWorkflowStep` / `friendlyStepLabel` from `modules/harness/profile.ts` (the reader is already generalized for a second caller)
- [x] 4.3 Mount it between the stream's scroll region and the chat bar as a full-width background-painted box with `flexShrink={0}`; contribute zero rows when there is no run to show
- [x] 4.4 Implement navigation across active runs — cycling, wrapping, with a position indicator — reachable by chord and by click
- [x] 4.5 Implement auto-advance on terminal, and empty the panel when no active run remains
- [x] 4.6 Implement dismiss and restore, leaving the run and its other surfaces untouched while dismissed
- [x] 4.7 Verify layout with the height-sweep harness, asserting no stream bleed at the panel boundary and no collapse on a short terminal
- [x] 4.8 Render tests for each state: no run, one run, several runs, focused run terminating and advancing, dismissed

## 5. Completion announcement

- [x] 5.1 Convert `src/tui/hooks/notice.ts` from a single slot to a FIFO queue that drops nothing, documenting why the replace-on-arrival model is wrong for unsolicited notices
- [x] 5.2 Raise a completion notice on every terminal run status, toned by outcome, carrying the run label, counts, duration, and — for a non-success — the reason
- [x] 5.3 Append the durable outcome record to the analysis thread using the harness's exported synthetic-message constructor; never hand-assemble the marker
- [x] 5.4 Key both reactions by `(runId, terminal status)` so a recovery re-delivery neither re-notifies nor re-appends
- [x] 5.5 Ensure an append failure still shows the notice and surfaces the record failure, and that neither can fail a turn or the run
- [x] 5.6 Serialize durable thread writes both ways: a user message submitted during an append is queued (composer accepts it, turn begins after), and a run terminating mid-turn defers its append until the turn's own append completes — implemented separately from the generation token, which drops losers rather than queueing them
- [x] 5.7 Test: two runs terminating within the display window both announce
- [x] 5.8 Test: a re-delivered terminal state produces exactly one notice and one record
- [x] 5.9 Test: the appended record is present in the thread after a reload, and appending starts no turn
- [x] 5.10 Test: a message submitted mid-append is queued and lands; a run terminating mid-turn leaves the turn's rows contiguous

## 6. Transcript rendering

- [x] 6.1 Make `run_card_block.tsx` resolve its run by the `runId` it carries and render live progress while active
- [x] 6.2 Settle the card on terminal: collapse the live chrome to a compact outcome line with status, counts, duration, and failure reason; never hide it, never keep a frozen meter
- [x] 6.3 Render an unavailable state for a card whose run cannot be resolved, rather than a fabricated status
- [x] 6.4 Teach `cortexToUiMessage` to recognise a harness synthetic message via the exported predicate and map it to an event entry — no user/assistant marker, not counted as a turn, not offered as retractable
- [x] 6.5 Test: a settled card renders correctly after a transcript reload; a synthetic entry never renders with the user marker even when its text resembles user prose

## 7. Sub-agent activity line

- [ ] 7.1 Turn `isSubAgentEvent` from a discard into a routing predicate, directing sub-agent events to their originating tool block instead of the transcript root — in both the REPL printer and the TUI reducer, which share the predicate
- [ ] 7.2 Render a single subordinate activity line on a running `ToolBlock` showing the innermost sub-agent's current activity (selected by `callPath` depth), removed when the call finishes
- [ ] 7.3 Test: a long tool call shows an updating activity line and no transcript-level block is created for sub-agent events

## 8. Keymap and palette

- [ ] 8.1 Declare the panel's navigation and dismiss/restore bindings as a reactive layer with descriptions and a group, using Ctrl-based chords and lowercase labels, with no unmodified printable keys
- [ ] 8.2 Derive every displayed label from its chord rather than hand-writing it
- [ ] 8.3 Add a palette command that restores the panel, mirroring how the sidebar toggle is exposed
- [ ] 8.4 Test: bindings appear in the which-key overlay; typing in the composer triggers none of them

## 9. Design gallery and close-out

- [ ] 9.1 Add gallery exhibits for every panel state and for the run card's live and settled states, plus the tool block's sub-agent activity line
- [ ] 9.2 Check every new or changed surface on a light theme, asserting span colors rather than character frames for any legibility claim
- [ ] 9.3 Run `bun run format:file` on every changed file under `src/`, then `bun run typecheck`, `bun run lint`, and the test suite
- [ ] 9.4 Run `openspec validate live-run-observability`
- [ ] 9.5 Confirm nothing here reads the DBOS `"events"` stream, initiates an assistant turn, or cancels a run — keeping the #247, #248, and #250 boundaries intact
