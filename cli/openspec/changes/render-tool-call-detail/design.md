# Design — render tool call details and outcomes

## Context

The harness change `add-tool-call-detail` supplies two new facts per tool call: an optional one-line `detail` and a three-way `outcome` (`ok` / `error` / `denied`). Both arrive on `tool-started` and `tool-finished`, and both are rebuilt on reload. This change places them.

The CLI consumes harness events in process. `applyEmitEvent` (`src/tui/hooks/conversation.ts`) types on `Parameters<EmitFn>[0]` and reads the loop's own event, not the wire vocabulary. The reload path runs `contentToCortexMessages` through the `toCortex` seam, and `loadMessages` already holds the booted runtime.

`ToolBlock` today paints the marker, the tool name in the `tool` role, an optional `target` in the muted role, and a status that flows inline after them. `ToolBlockProps.target` is documented as fixture-only; live harness events never set it.

Constraints inherited from the repository: the design gallery is the source of truth for TUI surfaces, every `<text>` resolves an explicit foreground, no glyph literal outside `GLYPHS`, no new dependency, and neverthrow-first error handling.

## Goals / Non-Goals

**Goals:**

- Show what a call is doing without ever truncating the informative end of a path.
- Keep a tool-heavy turn readable — the transcript is a scrolling log, not a form.
- Stop reporting a failed reloaded call as a success, and stop reporting a user's refusal as a fault.
- Keep host-contributed tools' details alive across reload.

**Non-Goals:**

- The `warning` tier for ok-channel outcomes (`no_matches`, `blocked`) — issue #281.
- Structured detail. The harness contract is one opaque string, and this change must not parse it.
- Result panels, diffs, or promotion of any tool to a card.

## Decisions

### D1 — Reflow to a continuation row, do not truncate and do not always split

The detail stays on the name line when it fits the available width. When it does not, it drops to one indented row beneath.

Two alternatives were rejected:

- **Always one row.** A renderer handed one opaque string can only cut from the right, so `runs/2026-07-30/step-2/output/summary.md` loses `summary.md` — the part that identifies the file. The harness contract forbids parsing the string to elide it more cleverly.
- **Always two rows.** It doubles the height of every tool call. `CONVERSATION_MAX_ITERATIONS` is 50 and one iteration can dispatch several calls, so a heavy turn already produces many chips. It also renders a ragged transcript while any tool lacks a hook, since a hookless call has nothing to put on row 2.

Reflow keeps short details compact and long details whole, and a hookless call is simply the fitted case with an empty detail.

### D2 — On the split, the status stays on the name line

Fitted: `▸ read_file src/app.ts  ✓ ok · 14ms`

Split:
```
▸ read_file                                    ✓ ok · 14ms
  runs/2026-07-30/step-2/output/summary.md
```

The status does not follow the detail down. Row 1 then carries only the marker, the tool name, and the status — the longest conversation tool id is `gene_preclinical_profile` at 24 characters, so row 1 tops out near 40 cells and does not wrap on a normal terminal. The status therefore lands in a near-constant column on every split block, which is the scanning property the current inline-flow rule cannot offer.

This does **not** license right-alignment. `tui-stream-blocks` rejects a right-aligned status because a wrapped right-aligned segment lands at column 0 and breaks the 2-cell gutter, and row 1 can still wrap on a very narrow terminal. The status keeps flowing inline after the name; the split merely removes the variable-length detail that was pushing it around.

### D3 — Measure conservatively, and prefer an early split to a late one

`useTerminalDimensions()` supplies the width. `plan_card_block.tsx` already establishes the arithmetic: `dims().width - size.railWidth - space.md - size.gutter`, with a floor. `activity_panel.tsx` establishes the selection shape — pick the widest variant that fits.

The formula subtracts `size.railWidth` unconditionally, as `plan_card_block` does, even though the sidebar is toggleable. This is deliberate: the failure mode of over-subtracting is an unnecessary split, which is merely taller. The failure mode of under-subtracting is a soft wrap at column 0, which breaks the gutter — the defect `tui-stream-blocks` already documents. Bias toward the harmless failure.

### D4 — `target` becomes `detail`

One field, one honest name. `target` is documented as "what the tool acted on", and `hypothesis retire h3` is a verb phrase, not a target. Keeping both fields would put two competing muted strings on one line for a single line of information.

The gallery fixtures are the only current writers, so the rename is contained.

### D5 — `denied` reuses `GLYPHS.warning`, it does not get a new glyph

The tool-call status becomes `"running" | "ok" | "error" | "denied"`. `denied` renders `GLYPHS.warning` in the `warning` role with the label `denied`.

`GLYPHS.warning` is documented in `design_system.ts` as "a soft 'needs attention' weaker than `cross`", which is exactly a refusal: nothing broke, the user said no. Adding a glyph to the design system needs its own conversation, and this change does not need one.

Consequence noted: issue #281 will also want `⚠` for ok-channel outcomes such as `no matches`. Sharing the glyph across both is correct — the tier means "soft, not a fault" — and the label carries the distinction.

### D6 — The detail row sits above the sub-agent activity row

A running sub-agent tool can reach three rows:

```
▸ literature_reviewer                              ▸ running
  review "CRISPR off-target detection in T cells"
  → literature-reviewer: pubmed
```

Both subordinate rows indent by `space.md`, so they align. The detail row comes first because it describes the call, which is stable, and the activity row describes the moment, which changes. `tui-stream-blocks` already requires the activity row to disappear on completion, so the block settles to at most two rows.

### D7 — The reload resolver is built at `loadMessages`, not inside the seam

`loadMessages` already calls `seams.runtime()` and returns early when boot is not ready. `HarnessRuntime.conversationAgent.tools` is the composed list — harness tools plus the three host tools wired at `runtime.ts`. The `toCortex` seam gains the tool list as a parameter rather than reaching for the runtime itself, so the existing test fakes keep working the way `LoadSeams` was built for.

## Risks / Trade-offs

**The split rule makes rendering width-dependent, so a frame test at one width proves little** → Sweep widths in the render tests, as `activity_panel.render.test.tsx` already does. Cover at least: wide, the 40-column sidebar-open case `tui-stream-blocks` already mandates, and a width where a specific detail crosses the boundary.

**A tool-heavy turn grows taller whenever details are long** → Accepted. Only calls whose detail does not fit pay the extra row, and the alternative is losing the end of every long path.

**The rename touches fixtures and could silently blank the gallery** → The gallery is the source of truth for these surfaces; the new states are added in the same change, so a blank exhibit is visible immediately.

**Frame assertions cannot prove the detail is legible** → `cli/CLAUDE.md` is explicit that a character frame carries no color. The muted detail role and the `warning` role for `denied` need span-color assertions via `captureSpans()`, and a check on a light theme where an unresolved foreground is invisible rather than merely wrong.

**This change and the harness change are one cutover** → The CLI cannot typecheck against the old harness after this lands, nor against the new harness before it. Accepted; the two are sequenced by the user.

## Open Questions

None. The one question this design carried is settled below.

### Settled: `subAgentActivityLabel` keeps agent plus tool name

`subAgentActivityLabel` (`chat_printer.ts`) stays at `${agentId}: ${toolName}` and does not compose the detail, even though the event carries it.

The value of composing it scales with hook coverage, and coverage is thin exactly where this line appears. The literature reviewer's roster holds six tools and the harness change hooks two of them. A line whose only job is to show that a long call is still moving, but which changes for a third of calls, is worse than one that is honestly static: the reader cannot distinguish a frozen line from a frozen agent.

Composing the full detail was also rejected on layout grounds. `→ literature-reviewer: pubmed` already measures 30 cells against roughly 36 usable at the sidebar-open width, so any detail after it wraps — and `tui-stream-blocks` requires this to be a single subordinate line.

When the remaining bio tools carry hooks, compose the detail with a cap for this line. Truncating here does not contradict the never-truncate rule the detail row follows: the activity line is ephemeral by contract and vanishes when the call finishes, so nothing durable is lost.
