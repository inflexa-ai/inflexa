## Context

`SelectList` is the shared fuzzy-filtered picker used by the command palette, theme picker, analysis/session switchers, and the file picker's review mode. It currently supports only single-select (pick one, call `onSelect`, done). Multi-select with gutter markers, toggle, and explicit confirm is hand-built inside `FilePicker` — duplicating rendering logic that belongs in the shared widget.

Both components render inside an opentui scrollbox. `SelectList` uses `<For>` (reference-keyed), which has a known bug: when the filtered array shrinks then grows, `<For>` tries `insertBefore` DOM operations that the scrollbox silently drops. `FilePicker` already fixed this by switching to `<Index>` (position-keyed). `SelectList` carries the same latent bug.

## Goals / Non-Goals

**Goals:**

- Fix the latent `<For>` scrollbox bug in `SelectList` by switching to `<Index>`.
- Add `mode` prop to `SelectList` supporting `"single"`, `"multi"`, and `"radio"` selection modes.
- Extract the selection gutter, toggle logic, and confirm/cancel flow from `FilePicker` into `SelectList`.
- Slim `FilePicker` to own only filesystem concerns, delegating list rendering to `SelectList` in multi mode.
- Zero behavior change for existing single-mode consumers.

**Non-Goals:**

- Changing `FilePicker`'s INSERT/NORMAL two-mode keyboard pattern — that stays in FilePicker.
- Adding drag-select, range-select, or shift+click — not needed today.
- Touching `PromptDialog` or `ResultsDialog` — unrelated widgets.
- Building a separate `FixedSelectList` component — one component handles both static and dynamic arrays.

## Decisions

### D1: One component, not two

**Decision:** Keep a single `SelectList` using `<Index>`, not a `FixedSelectList`/`SelectList` split.

**Rationale:** The `<For>` vs `<Index>` distinction is a workaround for an opentui scrollbox bug, not a semantic API boundary. `<Index>` works correctly for both static and dynamic arrays. The only cost is ergonomic: `<Index>` gives `(item: Accessor<T>, index: number)` vs `<For>`'s `(item: T, index: Accessor<number>)` — calling `item()` instead of `item` in the render body. For list-sized renders, the re-run cost per position is negligible.

**Alternative considered:** Two components sharing a core. Rejected because: (a) the `<For>` version carries a known bug for no benefit, (b) consumers don't care which Solid primitive renders the list, (c) two components means two sets of keyboard/gutter/footer logic to maintain.

### D2: Mode prop drives behavior, not separate components

**Decision:** A `mode: "single" | "multi" | "radio"` prop on `SelectList` controls gutter, keyboard, and confirm behavior.

- **single** (default): Current behavior — `enter` or click calls `onSelect(value)` and the caller closes. No gutter column. No confirm step.
- **multi**: Gutter column with ○/● markers. `space` toggles the highlighted row. `enter` calls `onConfirm(selected)`. `esc` calls `onCancel`. Selection state is owned by `SelectList` via a `selected` signal, seeded from an optional `initialSelected` prop.
- **radio**: Gutter column with ○/● markers. `space` or `enter` on a row selects it (deselecting the previous). A separate confirm action calls `onConfirm(selected)`. Useful for "pick exactly one but let me browse first" flows.

**Rationale:** A single component with mode-driven behavior is simpler than three components or a render-prop composition. The modes share 90% of the code (fuzzy filtering, cursor movement, scrollbox, footer). Only the gutter column, the key handler for space/enter, and the confirm flow differ.

### D3: Selection state ownership

**Decision:** In multi/radio mode, `SelectList` owns the working selection as a `createSignal<Set<T>>`, seeded from `initialSelected?: ReadonlySet<T>`. The caller receives the final set via `onConfirm(values: T[])`.

**Rationale:** The selection is transient dialog state — it exists only while the picker is open. The caller seeds it (e.g. FilePicker passes its `selected()` set) and gets back the result. This matches the existing FilePicker pattern.

**Alternative considered:** Controlled mode (caller owns the signal, passes `selected`/`onToggle`). Rejected for now: it adds wiring complexity, and no current consumer needs real-time external observation of the selection mid-dialog.

### D4: FilePicker composition

**Decision:** `FilePicker` renders `SelectList` in multi mode inside its `DialogPanel`, passing the filesystem rows as items. FilePicker keeps:
- `cwd` / `setCwd` signals and `listDir` / `intoDir` / breadcrumb logic
- INSERT/NORMAL two-mode keyboard with `inputFocused` signal
- Hidden-file toggle (`a`), review mode (`s`), open-in-explorer (`o`)
- Its own `DialogPanel` chrome (title, breadcrumbs, filter input, footer hints)

FilePicker drops:
- The manual `<Index>` loop with gutter markers — replaced by SelectList's multi-mode rendering
- The `toggleSelected` function and `space` keybinding — delegated to SelectList
- The `scrollRef` / `scrollChildIntoView` / row-id management — owned by SelectList

**Key integration point:** `SelectList` in multi mode needs to expose its cursor and selection state so FilePicker can drive dir navigation (`enter` on a dir row calls `intoDir` instead of confirm) and display the selected count in its footer. This is done via a render-callback or by having `onSelect` in multi mode fire on `enter` with the highlighted item, letting the caller decide whether to navigate or confirm.

### D5: `SelectList` exposes `onHighlight` for enter-overloading

**Decision:** Add an optional `onAction?: (value: T) => boolean` callback. In multi mode, when the user presses `enter`, `SelectList` calls `onAction(highlightedValue)`. If it returns `true`, SelectList treats it as handled (the caller navigated into a dir). If `false` or absent, SelectList runs its default confirm behavior.

**Rationale:** FilePicker overloads `enter` — on a dir row it navigates, on anything else it confirms. This is FilePicker-specific behavior that shouldn't be baked into SelectList's mode logic. The callback lets the caller intercept without SelectList knowing about directories.

## Risks / Trade-offs

- **`<Index>` re-run cost**: `<Index>` re-runs the body for every slot whose item changes, not just new/removed items. For list-sized renders (< 1000 rows), this is negligible. If a future use case renders thousands of rows with expensive per-row computation, memoizing per-row data will be needed. → Acceptable today; the file picker and palette are both well under 1000 rows.
- **Mode prop complexity**: Three modes in one component risks an unmanageable conditional soup. → Mitigated by keeping the mode-specific logic concentrated in three areas: gutter render, space/enter handler, and footer hint text. The shared code (filtering, cursor, scrollbox, `<Index>` loop) is mode-agnostic.
- **FilePicker integration surface**: FilePicker's `enter`-overloading (dir navigation vs confirm) requires the `onAction` callback, adding a non-obvious control-flow path. → Documented in JSDoc; the pattern is "return true to suppress default".
