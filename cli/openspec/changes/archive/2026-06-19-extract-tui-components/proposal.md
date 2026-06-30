## Why

The TUI's reusable widgets have outgrown the flat `src/tui/` layout that CLAUDE.md said to keep "while the surface is small … until shared widgets emerge." They have emerged: `SelectList` already has two importer files and four mount sites, and `PromptDialog`/`ResultsDialog` are equally generic but buried inside `command_palette.tsx`, making that file a grab-bag rather than a palette. All three repeat the same dialog chrome (bordered panel + accent title + muted footer hint), and the `Notice` presentation type is defined twice — identically — in `commands.tsx` and `config.tsx`, with its color mapping inlined in `app.tsx` and duplicated in `config.tsx`. This is a behavior-preserving cleanup that draws the line the codebase already anticipated.

## What Changes

- Create `src/tui/components/` — the home for shared, domain-agnostic TUI widgets. Membership rule: depends only on `theme` + opentui/solid, no domain imports, ≥2 callers.
- Move the three generic dialog widgets into it, each in its own file: `SelectList` (+ `SelectItem` + the fuzzy scorer) from `select_list.tsx`, and `PromptDialog` + `ResultsDialog` from `command_palette.tsx`.
- Add a new `DialogPanel` shell component that absorbs the repeated chrome (bordered `bgPanel` box, accent title, optional muted footer hint). The three dialog widgets render their body inside it and supply only their footer text.
- Reduce `command_palette.tsx` to palette-only: `runCommand` + `CommandPalette`. The palette-specific `CommandPalette` adapter stays in `tui/` (app-shell), not `components/`.
- Dedup the `Notice` presentation concern: a single shared `Notice` type and a `noticeColor(kind)` helper added to `src/tui/theme.ts` (the reactive theme accessor — a notice kind maps onto a palette role), consumed by `commands.tsx` (the `CommandContext.notify` signature), `app.tsx` (the transient banner), and `config.tsx` (the in-flow notice text). The two screens keep their distinct banner layouts — only the type and color mapping are shared (a single-caller `NoticeBanner` component is NOT extracted).
- Update all importers to the new locations with no shims, and update the CLAUDE.md `src/tui/` inventory note to list `components/` (and note `theme.ts` now also holds `Notice`/`noticeColor`).

No behavior changes, no new dependencies.

## Capabilities

### New Capabilities
- `tui-components`: A shared, domain-agnostic TUI widget library under `src/tui/components/` with an explicit membership rule, the relocated dialog widgets (`SelectList`, `PromptDialog`, `ResultsDialog`), a `DialogPanel` chrome shell they compose, and a single shared `Notice` type + `noticeColor` color mapping for status-line feedback.

### Modified Capabilities
<!-- None. This is a behavior-preserving refactor: the command-palette spec describes
     palette/dialog behavior, not file locations, and that behavior is unchanged. -->

## Impact

- **New files:** `src/tui/components/dialog_panel.tsx`, `src/tui/components/select_list.tsx`, `src/tui/components/prompt_dialog.tsx`, `src/tui/components/results_dialog.tsx`.
- **Removed files:** `src/tui/select_list.tsx` (moved).
- **Modified files:** `src/tui/theme.ts` (gains the shared `Notice` type + `noticeColor`), `src/tui/command_palette.tsx` (now palette-only), `src/tui/commands.tsx` (imports `PromptDialog`/`ResultsDialog`/`SelectList` from `components/`, imports `Notice` from `theme.ts`), `src/tui/app.tsx` (imports `Notice` + `noticeColor` from `theme.ts`), `src/tui/config.tsx` (imports `Notice` + `noticeColor` from `theme.ts`).
- **Docs:** CLAUDE.md `src/tui/` inventory note.
- **No change to:** runtime behavior, the event bus, the DB layer, `package.json` dependencies, or any module under `src/modules/`.
