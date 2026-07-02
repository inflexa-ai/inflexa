# Tasks — rework-select-lists

## 1. Rendering-contract sentinel

- [x] 1.1 Add the For-in-scrollbox regression render test (testRender + captureCharFrame): shrink-then-grow with stable refs, reordered subsets, grouped tuples with fragment children + nested `<For>`; assert all rows present and zero `insertBefore` warnings (list-primitives spec, D8)

## 2. List primitives

- [x] 2.1 Build the shared list core colocated with the primitives: `SelectItem<T>`, `rankBy` filtering off a reactive `query` accessor, post-ranking `[category, items[]][]` grouping + flat projection, cursor state + clamp, ScrollPane composition (`focusOnMount={false}`, `scrollChildIntoView` incl. group-header pull-in), empty-state + painted full-width description line
- [x] 2.2 Implement selection/submit in the core: `mode: "single" | "multi"`, single enter → `onSelect`, multi space → toggle with `initialSelected` seed, enter → `onConfirm`, `onAction` pre-submit interceptor; keyboard layer via `useDialogBindings` (↑/↓, ctrl+p/n, enter, space in multi) with the `enabled` accessor passthrough
- [x] 2.3 Implement row rendering: single-mode `>` chevron + `bgActive` cursor row, multi-mode ●/○ gutter (`GLYPHS.circle`/`circleHollow`), category headers, `hint` column; `<Index>` slot bodies read via accessors
- [x] 2.4 Export `FixedList<T>`: `readonly Readonly<SelectItem<T>>[]` items, read-once at mount (documented `eslint-disable solid/reactivity -- seed-once`), `<For>` rendering
- [x] 2.5 Export `DynamicList<T>`: reactive items, `<Index>` rendering
- [x] 2.6 Render tests for both primitives: filtering with header survival, cursor clamp + scroll-into-view, single select-and-submit, multi toggle/seed/confirm, `onAction` interception, `enabled` gating, FixedList replacement inertness, DynamicList in-place item replacement

## 3. SelectDialog and call-site migration

- [x] 3.1 Build `SelectDialog<T>` (DialogPanel + `TextInput chrome="bare"` via `setInitialFocus` + FixedList; `useDialogCancel`; mode-aware `chordLabel`-derived footer incl. multi selection count)
- [x] 3.2 Migrate the six `commands.tsx` pickers (theme, analysis, session, project set/list/delete, remove-input) and the `CommandPalette` adapter to `SelectDialog`
- [x] 3.3 Delete `select_list.tsx` (no shim); update the dialog-host render tests that mount `SelectList`; sweep remaining references
- [x] 3.4 Add design-gallery exhibits: FixedList/DynamicList states (filtered-with-headers, single cursor, multi gutter, empty) and SelectDialog single/multi

## 4. FilePicker

- [x] 4.1 Build the listing layer: dirent-based `listDir` (dirs-first case-insensitive sort, symlink-to-dir classification, error degradation), canonicalized cwd, synthetic `..` row (hidden while filtering, never toggleable), breadcrumb segments
- [x] 4.2 Build `FilePicker` on multi-mode `DynamicList`: absolute-path selection set (canonicalized seed, survives navigation), `onAction` directory descent, `requireSelection` refusal with warning notice, confirm → absolute paths
- [x] 4.3 Wire the INSERT/NORMAL keyboard model: input focus tracking, esc blur / `i` focus, space gate via the list's `enabled` passthrough, `a` hidden toggle, `s` review mode (selected-set list with deselection, root-relative titles), `o` open-in-explorer, mode-aware footer with selection count
- [x] 4.4 FilePicker render tests: navigation + filter reset, `..` semantics, selection survival across navigation, INSERT/NORMAL space behavior, requireSelection refusal, unreadable-dir degradation
- [x] 4.5 Add the FilePicker design-gallery exhibit

## 5. Analysis-flow wiring

- [x] 5.1 Wire new-analysis to open `FilePicker` (seeded empty, `requireSelection`) and add-inputs to open it seeded with existing inputs; confirm applies adds/removes through the analysis write path
- [x] 5.2 Emit input-change bus events from the input mutations (`types/events.ts` + `db/primary_mutation.ts` per the stashed wiring) and subscribe the sidebar for live refresh (with `onCleanup`)

## 6. Verification

- [x] 6.1 `bun run typecheck`, `bun run lint`, full `bun test`; `bun run format:file` on all touched `src/` files
- [x] 6.2 Manual TUI pass: every migrated picker, palette, file picker in both flows, dialog stacking (picker → confirm), theme switch live-recolor
