# Design — theme picker live preview

## Context

Two theme switch surfaces exist. The `inflexa config` screen previews live: moving the highlight calls `setTheme(id)` (the whole render root recolors reactively) and a non-commit close reverts to the saved theme via `useDialogClose` (`app_config.tsx:147-150`). The palette's "Change theme" picker (`ThemePicker`, `commands.tsx:163`) opens a `SelectDialog` over the ten built-in themes but applies `setTheme` only in `onSelect` — no preview while navigating.

The plumbing for preview already half-exists: `ListCore` fires an `onCursorChange` callback on every cursor move — including the filter-driven jump to the best match and `undefined` when the list empties (`list_core.tsx:204`) — and the list-primitives spec already requires it. `SelectDialog` simply doesn't forward it. Theme state is one global signal (`tui/theme.ts`), so a `setTheme` from inside the dialog recolors everything, dialog included.

## Goals / Non-Goals

**Goals:**

- The palette theme picker previews the highlighted theme immediately, reverts on any non-commit close, and persists only on select — behavioral parity with the config screen's preview contract.
- The picker opens with the cursor on the persisted theme, so opening it does not flash to row 0's theme.
- The enabling seams (`onCursorChange` and `initialValue` on `SelectDialog`; `initialValue` on the list primitives) stay generic — no theme-specific code below `ThemePicker`.

**Non-Goals:**

- No behavior change to any other picker (model, session, project…): they gain the props but don't use them.
- No config-screen changes — it already implements the contract this change copies.
- No multi-mode preview semantics: `initialValue` seeds a cursor, not a selection (`initialSelected` already owns that).
- No persistence-path changes: select still `setTheme` + `writeConfig` + close; a failed write still leaves the applied-but-unpersisted theme with an error notice (existing behavior).

## Decisions

### 1. Preview rides the existing `onCursorChange`, forwarded through `SelectDialog`

`SelectDialog` gains an optional `onCursorChange` prop passed straight to its `FixedList`. `ThemePicker` uses it to `setTheme` the highlighted id.

- *Alternative — bespoke picker composing `TextInput` + `FixedList` directly:* rejected; it would duplicate `DialogPanel` chrome, footer derivation, and the INSERT/NORMAL wiring for one forwarded prop.
- *Alternative — a theme-specific `previewTheme` prop on `SelectDialog`:* rejected; the list contract already has the generic callback, and the dialog should stay domain-agnostic.

### 2. Initial cursor is seeded by value (`initialValue`), not by reordering items

`ListProps` gains `initialValue?: T`; at mount, `ListCore` seeds the cursor onto the row whose `value` strict-equals it (`===` — callers pass primitive ids here; `ThemeId` is a string). Absent or unmatched, the cursor stays at row 0. `SelectDialog` forwards it.

- *Why not leave the cursor at row 0:* the cursor-change effect fires at mount, so without seeding, opening the picker instantly previews the first listed theme — a flash to `tokyo-night` for anyone on another theme.
- *Alternative — reorder items so the current theme is first:* rejected; the picker's listing order (five dark, then five light) is meaningful, and self-reordering pickers are disorienting.
- Seeding constraints: the seed must index the **flat (ranked→grouped) projection** the cursor indexes, not the raw items array (categories can interleave); it runs once in the component body at mount, before effects, so the mount-time `onCursorChange` and scroll-into-view effects both see the seeded row. The query/items cursor-reset effect is `defer: true`, so seeding does not trip it. For `DynamicList` the seed applies to the mount-time listing only — a replaced items array still resets to row 0, per its existing contract.
- Seeing the seeded row is not enough to **scroll** to it: `scrollChildIntoView` compares the child's computed geometry against the viewport's, and before the first frame lays the tree out both are zero, so the mount-time effect computes a zero delta and a below-fold seeded row would stay off screen. The re-scroll therefore cannot fire at a fixed delay — it has to wait for the layout itself. A running renderer schedules its next frame at `max(minTargetFrameTime - elapsed, 0)`, immediate only when a frame is already due, so while anything is animating (a spinner, a streaming response) the first layout lands up to a frame-time later and a one-shot `setTimeout(…, 0)` would measure the same zeros and no-op for good. `ListCore` instead polls (8ms × 12, ~96ms) and scrolls on the first tick that sees a non-zero viewport height — the exact condition `scrollChildIntoView`'s comparison needs. Bounded so a list that never gains height stops rather than ticking forever, registered only when a seed actually matched (unseeded lists pay for no timer), and cleaned up via `onCleanup`.

### 3. Revert lives in `ThemePicker.onCancel`; empty filter reverts too

`ThemePicker` captures the persisted id at open (it already reads it for the `current` hint) and:

- `onCursorChange(id)` → `setTheme(id ?? saved)` — a defined id previews it; `undefined` (filter matched nothing) reverts to the persisted theme rather than freezing the last preview, because the preview means "what enter would pick now", and with no rows enter picks nothing.
- `onCancel` → `setTheme(saved)` then close. `SelectDialog` already wires `onCancel` to every non-commit close (esc, click-outside, ctrl+c) via `useDialogCancel`, so one revert site covers all dismissal gestures — mirroring the config screen's `useDialogClose` revert.
- `onSelect` — unchanged (apply + persist + close). The close is a commit-reason pop, so no cancel fires after select.

### 4. Gallery exhibits are unaffected by construction

Showcased `SelectDialog`s pass neither new prop, so inert exhibits neither steal the cursor seed nor fire theme changes. `ThemePicker` itself is not exhibited.

## Risks / Trade-offs

- [Mount-time `onCursorChange` fires once with the seeded row] → intentional no-op: previewing the already-active theme changes nothing. Documented in the picker rather than suppressed with a first-fire guard.
- [`setTheme` per keystroke while holding ↓] → full-root repaint per move, but live in-place repaint is already the theme-system contract, the list is ten rows, and the renderer runs at 30fps; no debounce needed.
- [Preview leaks if a code path closes the dialog without cancel or select] → the dialog host funnels every dismissal into `cancel`/`dismiss`/`commit`; `useDialogCancel` covers the first two and select owns the third. No fourth path exists.
- [`initialValue` matching by `===` misses object-valued rows] → accepted; pickers key rows by primitive ids today, and the JSDoc states the strict-equality contract.
