## Why

The run-activity panel shipped, and watching a real run through it tells you almost nothing. Its activity line reads `sandbox.mint` while a container is provisioning, then `DBOS.writeStream` for the rest of the run — raw identifiers from the durability engine's internal step-cache table, which the panel reads directly. That table records a step only when it *completes*, so the line names whatever finished last rather than what is happening, and the emit calls that carry the real activity flood the same table with their own bookkeeping rows. The instrumentation drowns out the signal it exists to carry.

Meanwhile the harness has been emitting a human phrase on every sandbox-agent tool call the whole time (`Running script deseq2.R`), to a durable stream nothing reads.

Two further defects landed with the same work. The panel paints the same background as the transcript above it and draws no frame, so it reads as one more chat message that stopped scrolling — it is the only docked surface in the app that is not on the raised chrome surface. And the transcript's run card grew a live progress meter, which put the same `done/total` figure on screen in three places at once.

## What Changes

- The panel's activity label comes from the harness's run-event stream, so it names what a step is doing *now* and updates on every tool call.
- The panel stops reading the durability engine's internal tables. The label mapper built for those tables is retired from this path rather than repaired: it maps step-name shapes the analysis path never produces, and no repair makes a completed-step record describe in-flight work.
- The panel becomes visually distinct chrome: the raised surface every other docked surface uses, capped by a single top rule carrying a `RUN` label. **+1 row**, paid only while a run is active.
- The transcript run card returns to being a launch record that settles into an outcome. It carries no live meter, restoring the single-surface rule the card's own documentation stated before this regressed.
- Elapsed readouts in the panel advance on their own clock, so a stalled feed reads as stalled instead of as a run that is not progressing.
- The sidebar refresh cannot latch off permanently: a refresh that cannot finish releases its in-flight guard, which the capability already requires and does not implement.
- **Follow-up, not in scope**: a terminal rendering artifact in which non-ASCII glyphs are swallowed at zero width and a stale duplicate of each line's last character survives one cell to the right. It reproduces on `main` and is independent of this work.

  Recorded for whoever picks it up: it was seen in a GPU-accelerated emulator (Alacritty / WezTerm / kitty class) **running inside tmux**. That combination is the most likely explanation and should be tested first. The renderer probes for grapheme-clustering and explicit-width protocols that originate with kitty, then wraps non-ASCII glyphs in an escape those protocols define. tmux sits between the renderer and the emulator and does not implement them, so a probe answered favourably — whether by tmux passing it through to the outer terminal or by the outer terminal itself — leaves the renderer emitting sequences the actual consumer of its bytes swallows. The glyph is consumed as control-sequence payload, the row shifts left one cell per lost glyph, and the renderer's cell model no longer matches the screen, so it never repaints the stale trailing cell.

  Two cheap discriminating experiments: run the same build **outside** tmux, and run it inside tmux with the renderer's `wcwidth` width-method override forced. Either isolating the multiplexer or fixing it under the override confirms the mechanism.

## Capabilities

### Modified Capabilities
- `run-activity-panel`: the activity label's source changes from the durability engine's step records to the harness run-event stream; the panel gains its own chrome and an independent clock for elapsed readouts.
- `tui-stream-blocks`: the run card carries no live progress meter at any point in its life, not merely after settling.
- `sidebar-live`: the bounded-poll requirement gains the guarantee it already describes but does not deliver — a refresh that cannot complete must not disable future refreshes.

## Impact

- **Modified**: `src/tui/layout/run_activity_panel.tsx` (chrome, clock), `src/tui/hooks/run_panel.ts` (activity source), `src/tui/hooks/sidebar_live.ts` (refresh bounding), `src/tui/components/run_card_block.tsx` (drop the live meter), `src/lib/design_system.contrast.test.ts` (a new rendered pair), `src/tui/layout/design_gallery.tsx` (exhibits for the new chrome).
- **Retired from this path**: the `dbos.operation_outputs` reader used by the panel. The headless `inflexa run` wait shares that reader and is **not** changed here — it keeps working as it does today, and rewiring it is separate.
- **Depends on**: the harness `run-event-stream` capability. This change cannot land before it.
- **No breaking changes**: no command, keybinding, or persisted shape changes.
