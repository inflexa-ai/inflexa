# select-list-modes — delta

## REMOVED Requirements

### Requirement: SelectList selection mode prop

**Reason**: `SelectList` is deleted; selection modes move to the list primitives with a reduced `single | multi` union (`radio` had zero callers).
**Migration**: Use `FixedList`/`DynamicList` `mode` (see `list-primitives`), or `SelectDialog` for picker dialogs.

### Requirement: Single mode behavior

**Reason**: Superseded — single-mode select-and-submit is specced on the list primitives.
**Migration**: `FixedList`/`DynamicList` with `mode="single"` and `onSelect`; `SelectDialog` for the dialog form.

### Requirement: Multi mode behavior

**Reason**: Superseded — multi-mode toggle/confirm and the ●/○ gutter are specced on the list primitives.
**Migration**: `FixedList`/`DynamicList` with `mode="multi"`, `onConfirm`.

### Requirement: Radio mode behavior

**Reason**: Dropped without replacement — no caller exists; exclusive choice is a host-level concern over `multi` if ever needed.
**Migration**: None (no consumers).

### Requirement: Multi/radio initial selection

**Reason**: Superseded — seeding moves to the list primitives' `initialSelected` (multi only).
**Migration**: Pass `initialSelected: ReadonlySet<T>` to a multi-mode list.

### Requirement: Action callback for enter-overloading

**Reason**: Superseded — the `onAction` pre-submit interceptor is specced on the list primitives.
**Migration**: Pass `onAction` to `DynamicList` (the `FilePicker` directory-navigation case).

### Requirement: SelectList uses Index inside scrollbox

**Reason**: The blanket Index-only mandate was diagnosed on `@opentui/core` 0.4.0 and is fixed in 0.4.2 — the `<For>` reuse path (shrink-then-grow, reorder, grouped fragments) is verified correct. The rendering contract is now per-component: `<For>` for `FixedList` (stable references), `<Index>` for `DynamicList` (positional updates), guarded by a regression sentinel. See `HORRIBLE_BUG_FIXES.md` entry 1.
**Migration**: See `list-primitives` — "FixedList renders rows with For", "DynamicList renders reactive items with Index", and "For-in-scrollbox regression sentinel".
