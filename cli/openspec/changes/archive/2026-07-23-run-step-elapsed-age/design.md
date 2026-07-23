# Design: run-step-elapsed-age

## Context

`RunBlock` (`src/tui/components/run_block.tsx`) renders step rows as glyph + label from `RunStepView { label, state }`. Its three mounts build views from ledger rows at two mapping sites — the sidebar-live refresh (`src/tui/hooks/sidebar_live.ts:424`) and the run-detail dialog's step load (`src/tui/components/dialog/run_detail_dialog.tsx:88`) — plus the design-gallery mock. `StepExecutionRow.startedAt` is already in every ledger read; nothing renders it. The sidebar repaints on a bounded 5s poll while a run is active, minting fresh snapshot objects each tick.

## Goals / Non-Goals

**Goals:**

- A running step row answers "how long has this been going" at a glance, in every `RunBlock` mount.
- Zero new reads, timers, or transports — the age rides data and cadence that already exist.

**Non-Goals:**

- Durations on finished rows (the run-detail dialog already carries run-level duration; per-step durations are a different readout).
- A per-second ticker. Sidebar staleness is bounded by the 5s poll, which the sidebar's own time vocabulary accepts ("a slightly-stale age still reads right").
- Any harness change.

## Decisions

### D1: Carry `startedAt`, derive the age at paint

`RunStepView` gains `startedAt?: string | null` (ISO, running rows only need it); `RunBlock` derives the display via `Date.relativeAge` at render. Carrying the raw timestamp rather than a preformatted age keeps the formatter in one place (the CLAUDE.md time-rendering rule: elapsed indicators use `Date.relativeAge`, never a hand-rolled formatter) and lets each poll tick's re-render refresh the derivation for free. `Date.relativeAge` is a global extension, not a domain import, so `RunBlock` stays eligible for `components/` (theme + opentui/solid only).

### D2: Running rows only, rendered when present

The age renders only on `state === "running"` rows with a `startedAt`. Queued rows have not started; done/failed rows are history (durations belong to detail views); a running row missing its timestamp (defensive: the ledger column is nullable) renders exactly as today. Both mapping sites pass `startedAt` through unconditionally and let the render gate decide — the mapping stays a dumb projection.

### D3: Muted tone, after the label

The age is meta text and must clear the 4.5:1 information floor: `<Fg role="fgMuted">` beside the label, inside the row's existing `<text>`. It sits after the label so row scanning (glyph, then name) is undisturbed and truncation behavior for long labels is unchanged.

### D4: The dialog's age is elapsed-at-open

The run-detail dialog loads steps once at open; its ages are point-in-time, exactly like the profile dialog's documented "elapsed at the moment it was opened" precedent. No dialog-side timer.

## Risks / Trade-offs

- **[Row width grows by ~8 cells on running rows]** → The rail's step labels are short ids (`T3S1`); the windowed mount already tolerates variable label length. Verified in render tests at rail width.
- **[Sidebar age staleness up to one poll interval]** → Accepted; consistent with the sidebar's existing relative-age readouts, and the poll is armed whenever a run is active.

## Open Questions

None.
