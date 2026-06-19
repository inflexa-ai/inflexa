## 1. DialogPanel shell

- [x] 1.1 Create `src/tui/components/dialog_panel.tsx` exporting `DialogPanel({ title, width, height?, padY?, footer?, children })` — bordered `bgPanel` box, `borderColor` `theme().borderActive`, accent title, `paddingLeft/Right=1`, conditional top/bottom padding from `padY`, and a trailing muted footer line when `footer` is set. Pure chrome: no `useKeyboard`, no focus. JSDoc the export and every prop; never destructure `props`.

## 2. Relocate dialog widgets into components/

- [x] 2.1 Move `select_list.tsx` → `src/tui/components/select_list.tsx` (carry `SelectList`, `SelectItem`, and the private fuzzy scorer). Fix the `theme` import to `../theme.ts`. Refactor it to render its body (input, scrollbox, highlighted-row description) inside `DialogPanel` with `width="70%" height="60%"` and `footer="↑/↓ move · Enter select · Esc cancel"`. Delete the old file.
- [x] 2.2 Create `src/tui/components/prompt_dialog.tsx` with `PromptDialog` moved out of `command_palette.tsx`, rendering its input through `DialogPanel` with `width="60%" padY footer="Enter submit · Esc cancel"`.
- [x] 2.3 Create `src/tui/components/results_dialog.tsx` with `ResultsDialog` moved out of `command_palette.tsx`, rendering its scrollbox through `DialogPanel` with `width="70%" height="60%" footer="↑/↓ scroll · Esc/q close"`.
- [x] 2.4 Confirm each widget's keyboard handling, focus-on-mount, empty-state, and (for `SelectList`) ranking/grouping logic moved verbatim — only the chrome is now `DialogPanel`.

## 3. Reduce command_palette.tsx to palette-only

- [x] 3.1 Remove `PromptDialog` and `ResultsDialog` from `src/tui/command_palette.tsx`, leaving only `runCommand` and `CommandPalette`. Update its `SelectList`/`SelectItem` import to `./components/select_list.tsx`. Update the file header comment to drop the "two reusable dialog shells" description.

## 4. Shared Notice type and color mapping

- [x] 4.1 Add to `src/tui/theme.ts` the `Notice` type (`{ kind: "info" | "warn" | "error"; text: string }`) and `noticeColor(kind: Notice["kind"]): string` (reads `theme()` reactively, returns `info`/`warn`/`error` role color). JSDoc both. (Homed in `theme.ts` rather than a separate `notice.ts` — a notice kind maps onto a palette role, so `noticeColor` is a theme accessor.)
- [x] 4.2 In `commands.tsx`: delete the local `Notice` definition, import `Notice` from `./theme.ts`. (`CommandContext.notify` keeps its `Notice` parameter type.)
- [x] 4.3 In `config.tsx`: delete the local `Notice` type and local `noticeColor`, import both from `./theme.ts`.
- [x] 4.4 In `app.tsx`: import `Notice` + `noticeColor` from `./theme.ts` (replacing the `Notice` import from `./commands.tsx`); replace the inlined kind→color expression in the transient banner with `noticeColor(notice()!.kind)` used as `backgroundColor`.

## 5. Repoint importers, no shims

- [x] 5.1 In `commands.tsx`: import `PromptDialog`/`ResultsDialog` from `./components/prompt_dialog.tsx` / `./components/results_dialog.tsx` and `SelectList` from `./components/select_list.tsx`.
- [x] 5.2 Grep the repo for `select_list`, for `PromptDialog`/`ResultsDialog` imported from `command_palette`, and for `Notice` defined/imported outside `theme.ts`; confirm every reference points at the new locations and no shim/re-export remains.

## 6. Docs and verification

- [x] 6.1 Update the CLAUDE.md `src/tui/` inventory note to list `components/` (with its membership rule) and note `theme.ts` now also holds `Notice`/`noticeColor`, and adjust the "kept flat while the surface is small" line now that the dir exists.
- [x] 6.2 Run `bun run typecheck` and `bun run lint`; fix any dangling imports or type errors. (typecheck clean; lint 0 errors — the 14 warnings are pre-existing `solid/reactivity` notes in `app.tsx`/`commands.tsx`, none in changed widget files.)
- [x] 6.3 Run `bun run format:file` on every changed/added file under `src/`. (all unchanged — already conformant.)
- [ ] 6.4 Launch the TUI and verify the command palette, a picker (theme/switch-analysis), a prompt dialog (new project), a results dialog (list analyses), and a notice all render and behave identically to before. (Build-graph smoke via `bun build` passed — every new `components/*` import + the `theme.ts` `Notice`/`noticeColor` resolve. Interactive alt-screen visual confirmation still pending: needs a real TTY — run `bun run dev`.)
