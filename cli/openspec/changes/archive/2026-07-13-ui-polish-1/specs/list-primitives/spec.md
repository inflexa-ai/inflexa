## MODIFIED Requirements

### Requirement: Cursor navigation and scroll-into-view

Both lists SHALL own cursor state and register their keys via `useDialogBindings` (auto-suspended under a stacked dialog; gated by `!dialogIsOpen()` outside one), in two layers split by the bare-printable-key rule:

- **Always-on** (safe beside a focused editor): ↑/↓, ctrl+p/ctrl+n, page-up/page-down (±10 rows), enter.
- **Bare-printable** (gated by a `bareKeysEnabled` passthrough, which hosts with a focusable filter input MUST wire to `!inputFocused`): the vim cursor keys j/k (down/up), gg (first row), G (last row) — and space-toggle in multi mode.

End-of-list behavior splits by component through a `wrapNavigation` option on the shared core:

- **`FixedList`** SHALL enable it: single-step movement (↑/↓, ctrl+p/ctrl+n, j/k) wraps between the first and last item rows — stepping down from the last row lands on the first, stepping up from the first lands on the last (modular, so a single-row list is a no-op).
- **`DynamicList`** SHALL NOT enable it: single-step movement clamps at the ends, because a source that refilters or refreshes underfoot makes a surprise jump to the far end disorienting.
- Page movement (±10 rows) SHALL clamp at the ends in BOTH lists — the deliberate "slam toward the end" gesture must land on the end, not overshoot past it — and `gg`/`G` remain absolute jumps.

The list SHALL compose `ScrollPane` with `focusOnMount={false}` (the pane is never focused) and keep the cursor row visible via `scrollChildIntoView` — a wrap jump scrolls the destination row into view exactly as `gg`/`G` do — pulling a group header into view when the cursor sits on a group's first item. The cursor SHALL clamp when filtering shrinks the set. The whole layer set SHALL also accept an `enabled` passthrough so hosts can suspend the list entirely.

#### Scenario: Navigation keys move the cursor

- **WHEN** the user presses ↓ or ctrl+n
- **THEN** the cursor moves to the next item row and scrolls into view

#### Scenario: Vim keys move the cursor when no editor is focused

- **WHEN** `bareKeysEnabled` is true (no filter input holds focus) and the user presses j, k, gg, or G
- **THEN** the cursor moves down / up / to the first row / to the last row — and when an input is focused, those keys type into it instead

#### Scenario: FixedList wraps at the bottom

- **WHEN** the cursor sits on a `FixedList`'s last item row and the user presses ↓, ctrl+n, or j
- **THEN** the cursor lands on the first item row and it scrolls into view

#### Scenario: FixedList wraps at the top

- **WHEN** the cursor sits on a `FixedList`'s first item row and the user presses ↑, ctrl+p, or k
- **THEN** the cursor lands on the last item row and it scrolls into view

#### Scenario: DynamicList clamps at the ends

- **WHEN** the cursor sits on a `DynamicList`'s last item row and the user presses ↓
- **THEN** the cursor stays on the last row — no wrap

#### Scenario: Page movement clamps everywhere

- **WHEN** the cursor is within ten rows of an end and the user presses page-down (or page-up toward the start)
- **THEN** the cursor lands on the end row in both list components, never wrapping past it

#### Scenario: Host gates the layer

- **WHEN** a host passes `enabled: () => false`
- **THEN** none of the list's bindings fire

#### Scenario: Cursor clamps on shrink

- **WHEN** the cursor is on the last row and a query removes rows below the new end
- **THEN** the cursor moves to the new last row
