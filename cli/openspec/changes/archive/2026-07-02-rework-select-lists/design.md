# Design — rework-select-lists

## Context

`SelectList` (`src/tui/components/select_list.tsx`) is a dialog-fused monolith: DialogPanel chrome + filter `TextInput` + ScrollPane + `rankBy` ranking + keyboard + selection in one component, consumed by six pickers in `commands.tsx` and the command palette. It drops category grouping while a query is active, and supports only single selection.

Two stashes on this branch inform the design. stash@{1} holds a working multi-select `FilePicker`; stash@{0} holds a previous rework attempt that kept one `SelectList` and grew `mode`/`bare`/controlled-selection/imperative-ref flags — evidence that "one component, many flags" is the wrong shape. Both stashes predate the dialog-subsystem rework (f3fb866) and the keymap engine, so they are inspiration, not rebasable patches.

The stale `select-list-modes` and `tui-components` spec sections describe that stashed design (including a normative "always `<Index>`, never `<For>` in scrollbox" caveat). That caveat was diagnosed on `@opentui/core` 0.4.0 and is **fixed in 0.4.2**: a `testRender` repro of the `<For>` reuse path (shrink-then-grow with stable refs, reordered subsets, grouped fragments with nested `<For>`) renders correctly with zero warnings. See `HORRIBLE_BUG_FIXES.md` entry 1.

opencode's `DialogSelect` provides the representational model: options carry `category?: string`; the grouped shape `[category, items[]][]` is derived by `groupBy → entries` **after** filtering, so headers survive; a `flat` projection is what the cursor indexes.

## Goals / Non-Goals

**Goals:**

- Pure list primitives: `FixedList<T>` and `DynamicList<T>` are lists only — no dialog chrome, no filter input, no focus management of inputs.
- Category grouping that survives filtering, via the derived `[category, items[]][]` representation.
- Selection as a first-class list concern: `single` (enter = select-and-submit) and `multi` (space = toggle, enter = confirm batch).
- Rendering strategy per Solid's list-rendering model: `<For>` where item references are stable (`FixedList`), `<Index>` where content changes positionally (`DynamicList`).
- A `SelectDialog` wrapper that keeps the seven existing call sites one-liners, and a `FilePicker` with the stashed picker's functionality.

**Non-Goals:**

- `radio` mode (specced for the stashed design, zero callers — dropped; `multi` covers exclusive choice at the host level if ever needed).
- Mouse support beyond what opentui gives for free (opencode's hover/click model is out of scope).
- Changing `rankBy`/`subsequenceScore` — the ranking algorithm stays as-is (title 2×, category 1×).
- Upgrading `@opentui/*` — the design is verified against 0.4.2 exactly.
- Virtualization/windowing — picker-sized lists (≤ ~1000 rows) render fully.

## Decisions

### D1 — Two components, not one component with flags

`FixedList` and `DynamicList` share an internal core (grouping, cursor, selection, row rendering — colocated, since the two list components are its only callers) but are distinct exports with distinct contracts. The stash@{0} attempt showed the single-component alternative: a `bare` flag, dual chrome paths, controlled/uncontrolled selection, and an imperative ref for focus — rejected as accretive complexity.

### D2 — FixedList reads items once; DynamicList tracks them

TypeScript cannot express "this reference never changes"; it can express "you cannot mutate through this reference". So `FixedList` takes `items: readonly Readonly<SelectItem<T>>[]` **and reads the prop exactly once at mount** (deliberate non-reactive read, documented `eslint-disable solid/reactivity -- seed-once`): later replacement is inert by construction, which is the enforceable form of immutability. This is also what licenses `<For>`: the item references are stable for the component's lifetime. `DynamicList` reads `props.items` reactively.

### D3 — `<For>` in FixedList, `<Index>` in DynamicList

Straight from the Solid docs' Index-vs-For guidance:

- `FixedList` filtering produces subsets/reorders of **stable references** → `<For>` reuses surviving rows and moves them; rows never re-render while filtering. Safe on 0.4.2 (verified; on 0.4.0 this exact path silently dropped rows — the regression sentinel test guards the bump).
- `DynamicList` sources (directory listings) mint **fresh objects per update** → `<For>` would tear down and recreate every row; `<Index>` updates positional slots in place. Slot bodies must read through accessors (`item()`, `() => isCursor()`), never captured values.

### D4 — Hosts own the filter input; lists take `query`

The lists accept a reactive `query: string` prop ("filterable" = the host passes one; omit it for a static list). `SelectDialog` and `FilePicker` each own their `TextInput` and pass its value down. Rejected alternative: the list renders its own input when `filterable` (opencode's shape) — it forces `focusInput`/`blurInput`/`inputFocused` ref plumbing back into the list the moment a host (file picker) needs custom input placement or INSERT/NORMAL semantics, which is precisely the stash@{0} failure mode.

Ranking runs inside the list: `rankBy` first, then `groupBy → entries` to `[category, items[]][]`, then a `flat` projection for the cursor. Grouping after ranking is what keeps a category header visible when one item survives the filter.

### D5 — Lists own cursor, navigation keys, selection, and submit

Via `useDialogBindings`, which already degrades correctly everywhere (`dialog_host.tsx:217-224`: gates on `isTop()` inside a dialog — stacked dialogs auto-suspend — and on `!dialogIsOpen()` outside). Key contract:

- Always-on within the list's layer: ↑/↓, ctrl+p/ctrl+n, enter.
- `single`: enter calls `onSelect(value)` — select-and-submit in one stroke.
- `multi`: space toggles the cursor row (`onToggle`-style internal set seeded by `initialSelected`), enter calls `onConfirm(values)`.
- The layer accepts an `enabled?: () => boolean` passthrough so hosts gate conflicting keys: a focused filter input must receive space as a typed character, so multi-select hosts with a live input run the INSERT/NORMAL pattern (space toggles only while the input is blurred — the stashed picker's model). Single-select dialogs need no gate (enter/arrows don't collide with typing).
- Esc/cancel stays the dialog host's structural concern — lists never bind esc.

### D6 — Indicators: chevron for single, ●/○ gutter for multi

Single mode keeps our `>` chevron + `bgActive` cursor row (explicit user preference over opencode's full-row primary background). Multi mode adds a gutter using `GLYPHS.circle`/`circleHollow` (●/○) — opencode's ● vocabulary extended to the multi case opencode doesn't have. The highlighted row's `description` renders as the list's bottom detail line (full-width painted box — the yoga scrollbox-overlap rule).

### D7 — Composition layer: `SelectDialog` and `FilePicker`

- `SelectDialog<T>`: DialogPanel + `TextInput` (initial focus via `useDialogEntry().setInitialFocus`) + `FixedList`, single or multi. All six `commands.tsx` pickers and the palette migrate; `SelectList` is deleted in the same change (no deprecation window — internal API).
- `FilePicker`: DynamicList over `listDir(cwd, hideHidden)` (dirs-first, `Dirent`-based, error-degrading), synthetic non-toggleable `..` row, breadcrumb, INSERT/NORMAL modes, `a` hidden toggle, `s` review mode, `o` open-in-explorer, `requireSelection`, canonicalized absolute paths in/out. Enter on a directory navigates instead of confirming — `DynamicList` accepts an `onAction?: (value) => boolean` pre-submit interceptor (kept from the stashed design) for exactly this. Review mode is a view SWAP (a single-mode list over the selected set replaces the browse view), not a stacked dialog: the swap unmounts the browse list, and its remount-with-seed on return is precisely what lets review edit a selection the list otherwise owns internally — stacking would keep the browse list mounted and leave no way in.

### D8 — Regression sentinel for the opentui rendering contract

A dedicated render test (testRender + captureCharFrame) exercises `<For>`-inside-scrollbox through shrink-then-grow with stable refs, reordered subsets, and grouped fragments with nested `<For>`, asserting all rows present and zero `insertBefore` warnings. It exists so a future `@opentui/*` bump that regresses the 0.4.0 row-drop bug fails loudly; `HORRIBLE_BUG_FIXES.md` entry 1 names `<Index>` as the escape hatch.

## Risks / Trade-offs

- [`<For>` regression on future opentui bumps] → the D8 sentinel test turns a silent row-drop into a red test; the escape hatch (switch FixedList to `<Index>`) is documented in the postmortem.
- [FixedList read-once surprises a caller passing changing items] → the `readonly` type + JSDoc contract state it; `DynamicList` is the documented alternative; a dev-mode warning is possible but deferred (would need a reference-equality probe effect).
- [Space-toggle vs typing in multi mode] → resolved by the `enabled` gate + INSERT/NORMAL host pattern; the seam is per-host by design, so a host that forgets the gate gets space-toggles-while-typing — covered by FilePicker render tests.
- [`<Index>` slot bodies re-run on positional content change] → acceptable at picker scale (≤ ~1000 rows); accessor-pattern discipline documented in the component.
- [Migrating 7 call sites in one change] → they are thin (title/items/onSelect); the dialog-host render tests already cover open/dismiss flows and migrate alongside.

## Open Questions

None — the review-mode swap-vs-stack question resolved into D7 (swap; see the FilePicker bullet for why stacking cannot work with list-owned selection).
