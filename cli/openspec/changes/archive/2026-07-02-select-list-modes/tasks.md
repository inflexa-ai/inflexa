## 1. SelectList core: `<For>` → `<Index>` and mode prop

- [x] 1.1 Switch `SelectList` scrollbox rendering from `<For>` to `<Index>` — update the row render body to use `item()` accessor pattern. Verify existing single-mode behavior is unchanged.
- [x] 1.2 Add `mode` prop (`"single" | "multi" | "radio"`, default `"single"`) to `SelectList` props. Add `initialSelected` prop (`ReadonlySet<T>`, optional). Add `onConfirm` callback (`(values: T[]) => void`, required when mode is multi/radio). Add `onAction` callback (`(value: T) => boolean`, optional).
- [x] 1.3 Add internal selection state: `createSignal<Set<T>>` seeded from `initialSelected`. Wire `space` keybinding to toggle (multi) or select-one (radio). Wire `enter` to call `onAction` first, then `onConfirm` if not intercepted.
- [x] 1.4 Add gutter column rendering for multi/radio modes: ○ (unselected) / ● (selected) markers. No gutter in single mode. Use `GLYPHS.circle` / `GLYPHS.circleHollow` from `design_system.ts`.
- [x] 1.5 Update footer hint text to be mode-aware: single mode keeps current hints; multi/radio shows space-to-toggle, enter-to-confirm, esc-to-cancel, and selection count.

## 2. FilePicker composition

- [x] 2.1 Refactored FilePicker to use `SelectList` in `bare` + `multi` mode. Added `bare`, `onRef`, `onFilterChange`, `onBeforeToggle`, `errorText`, `titleColor` props to SelectList. Added `SelectListRef` handle type for imperative control.
- [x] 2.2 Wired `onAction` to intercept enter on dir rows → `intoDir`. Wired `onConfirm` to FilePicker's confirm logic with `requireSelection` guard.
- [x] 2.3 FilePicker seeds `initialSelected` from its `selected()` signal. SelectList owns the working selection copy. `onConfirm` returns the final set.
- [x] 2.4 FilePicker keeps breadcrumbs, DialogPanel chrome, footer hints (INSERT/NORMAL + a/s/o/i keys). Added `fpNormalActive` gate using `listHandle.inputFocused` for domain-specific NORMAL-mode bindings.

## 3. Consumer updates

- [x] 3.1 Verified existing single-mode consumers (command palette, theme picker, analysis/session switchers) — all pass `onSelect` without `mode`, defaulting to `"single"`. No changes needed.
- [x] 3.2 Verified FilePicker's review mode already uses `SelectList` with `onSelect` (default single mode). Deselect-on-pick behavior is correct. No changes needed.

## 4. Tests and verification

- [x] 4.1 Verified `file_picker.test.tsx` — no changes needed (FilePicker's gutter rendering is unchanged; 3/3 tests pass).
- [x] 4.2 Added `select_list.test.tsx` with 3 tests: single-mode chrome, multi-mode gutter/footer, and `<Index>` filter-then-clear round-trip.
- [x] 4.3 Typecheck clean, lint clean (0 new warnings), 254/254 tests pass. Formatted changed files.
