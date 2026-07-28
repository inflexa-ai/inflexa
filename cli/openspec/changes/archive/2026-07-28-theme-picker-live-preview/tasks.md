# Tasks — theme picker live preview

## 1. List primitives — initial cursor seeding

- [x] 1.1 Add `initialValue?: T` to `ListProps` in `src/tui/components/list_core.tsx` (JSDoc: strict-equality match, mount-time seed, no override of query/items cursor resets) and seed the cursor in `ListCore` onto the flat-projection row whose value matches, before effects run, falling back to row 0 when absent/unmatched
- [x] 1.2 Extend `src/tui/components/list_primitives.render.test.tsx`: mount with a matching `initialValue` (cursor row rendered as cursor, scrolled into view, mount-time `onCursorChange` reports it), mount with an unmatched value (cursor at row 0), and typing a query after a seeded mount still moves the cursor to the best match

## 2. SelectDialog — forward the seams

- [x] 2.1 Add `initialValue` and `onCursorChange` to `SelectDialogProps` in `src/tui/components/dialog/select_dialog.tsx` and forward both to the `FixedList`
- [x] 2.2 Add a render test covering the forwarding: a `SelectDialog` opened with both props starts on the seeded row and reports cursor moves (including `undefined` when the filter empties the list) to the host callback

## 3. ThemePicker — preview, revert, persist

- [x] 3.1 Rewire `ThemePicker` in `src/tui/commands.tsx`: keep the persisted id it already reads, pass `initialValue={current}`, preview via `onCursorChange` (`setTheme(id ?? current)`), revert in `onCancel` (`setTheme(current)` before closing), leave `onSelect` (apply + `writeConfig` + close) unchanged
- [x] 3.2 Cover the picker behavior with a test: cursor movement previews (active theme changes, config untouched), cancel reverts to the persisted theme, select persists — colocated with the existing commands/list render test patterns

## 4. Verify

- [x] 4.1 `bun run typecheck`, `bun run lint`, and the TUI test suites pass; `bun run format:file` on every touched `src/` file
- [x] 4.2 `openspec validate` passes for the change; confirm the design gallery's inert `SelectDialog` exhibits still render without cursor-seed or preview side effects (they pass neither new prop)
