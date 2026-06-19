# tui-components Specification

## Purpose
TBD - created by archiving change extract-tui-components. Update Purpose after archive.
## Requirements
### Requirement: Shared TUI component directory with a membership rule

The system SHALL house shared, domain-agnostic TUI widgets under `src/tui/components/`. A widget SHALL belong in `components/` only when it (a) imports nothing beyond `theme` and `@opentui/*` / `solid-js` — no imports from `src/modules/`, `src/db/`, or other domain code — and (b) has two or more callers. Widgets SHALL be one component per file (no barrel/index re-exports), and callers SHALL import each component from its own file. A palette- or feature-specific adapter (e.g. `CommandPalette`, which maps `Command` domain objects) SHALL NOT live in `components/`; it stays in the `tui/` app-shell.

#### Scenario: Generic widget lives in components/

- **WHEN** a widget imports only `theme` + opentui/solid and has ≥2 callers
- **THEN** it resides in `src/tui/components/` as its own file, imported directly by each caller

#### Scenario: Domain-coupled adapter stays out of components/

- **WHEN** a component imports domain types (e.g. `Command`, an `Analysis`) or module code
- **THEN** it stays in the `tui/` app-shell, not in `components/`

### Requirement: DialogPanel chrome shell

The system SHALL provide a `DialogPanel` component in `src/tui/components/` that owns the shared dialog chrome: a bordered box with `backgroundColor` `theme().bgPanel`, `borderColor` `theme().borderActive`, an accent-colored (`theme().accent`) title, and `paddingLeft`/`paddingRight` of 1. It SHALL accept `title`, `width`, optional `height`, an optional `padY` flag (top+bottom padding of 1), an optional `footer` string, and `children`. When `footer` is set, `DialogPanel` SHALL render it as the last child as a single muted (`theme().muted`) hint line. `DialogPanel` SHALL be pure chrome — it SHALL NOT own keyboard handling or focus; each composing widget keeps its own `useKeyboard` and focus-on-mount.

#### Scenario: Renders the shared chrome

- **WHEN** a widget renders its body inside `DialogPanel` with a `title` and `footer`
- **THEN** the panel shows the bordered `bgPanel` frame, the accent title, the body, and the muted footer line as the last row

#### Scenario: Footer is optional

- **WHEN** `DialogPanel` is given no `footer`
- **THEN** no footer line is rendered

#### Scenario: Does not capture the keyboard

- **WHEN** a dialog composed from `DialogPanel` is open
- **THEN** keyboard and focus behavior is driven by the composing widget, not by `DialogPanel`

### Requirement: Relocated dialog widgets compose DialogPanel without behavior change

`SelectList` (with `SelectItem` and its private fuzzy scorer), `PromptDialog`, and `ResultsDialog` SHALL live in `src/tui/components/`, each in its own file, and SHALL render their body through `DialogPanel`. Their observable behavior — filtering/ranking, navigation keys, submit/cancel/close keys, focus-on-mount, empty-state messages, and footer hint text — SHALL be unchanged from before the move. `SelectList` SHALL keep its highlighted-row description line inside its own body (above the footer).

#### Scenario: SelectList behavior preserved

- **WHEN** a caller renders `SelectList` from `src/tui/components/select_list.tsx`
- **THEN** fuzzy filtering, Up/Down + Ctrl+P/Ctrl+N navigation, Enter-to-select, Esc-to-cancel, and the grouped/empty-state rendering behave exactly as before

#### Scenario: PromptDialog and ResultsDialog relocated

- **WHEN** a caller needs a single-line prompt or a read-only results list
- **THEN** it imports `PromptDialog` / `ResultsDialog` from `src/tui/components/`, and Enter-submit / Esc-cancel and scroll / Esc-q-Enter-close behave exactly as before

#### Scenario: Footer hints unchanged

- **WHEN** any of the three dialogs renders
- **THEN** its footer hint text matches the pre-refactor text verbatim

### Requirement: command_palette.tsx is palette-only

After the move, `src/tui/command_palette.tsx` SHALL contain only the palette concerns: the single dispatch verb `runCommand` and the `CommandPalette` adapter. It SHALL NOT define `PromptDialog` or `ResultsDialog`. Every former importer of those widgets SHALL import them from `src/tui/components/` instead, with no compatibility shim or re-export left behind.

#### Scenario: Shells no longer defined in the palette file

- **WHEN** `command_palette.tsx` is read after the change
- **THEN** it defines `runCommand` and `CommandPalette` only, and exports no dialog shells

#### Scenario: No shim left behind

- **WHEN** the codebase is searched for re-exports of the moved widgets from `command_palette.tsx` or the old `select_list.tsx` path
- **THEN** none exist; every importer points at `src/tui/components/`

### Requirement: Single shared Notice type and color mapping

The system SHALL define the `Notice` type (`{ kind: "info" | "warn" | "error"; text: string }`) exactly once, in `src/tui/theme.ts`, together with a `noticeColor(kind: Notice["kind"]): string` helper that reads `theme()` reactively and returns the semantic color for the kind. They live in `theme.ts` (the reactive theme accessor) because a notice kind maps onto a matching palette role — `noticeColor` is a theme accessor. `commands.tsx` (the `CommandContext.notify` signature), `app.tsx`, and `config.tsx` SHALL import them from `src/tui/theme.ts`; the duplicate `Notice` definitions and the inlined/duplicated color mapping SHALL be removed. `noticeColor` SHALL be layout-agnostic — callers decide whether to use the returned color as a background or foreground. No `NoticeBanner` component SHALL be extracted, because the screens render notices with different layouts.

#### Scenario: One definition, three importers

- **WHEN** `Notice` or `noticeColor` is needed in `commands.tsx`, `app.tsx`, or `config.tsx`
- **THEN** it is imported from `src/tui/theme.ts`, and no other file defines `Notice`

#### Scenario: Color mapping is reused, layout is not

- **WHEN** `app.tsx` colors its transient banner and `config.tsx` colors its in-flow notice text
- **THEN** both derive the color from `noticeColor(kind)` while keeping their own distinct layouts

#### Scenario: Notice type stays out of src/types/

- **WHEN** deciding where `Notice` lives
- **THEN** it is in the `tui/` presentation layer (`src/tui/theme.ts`), not `src/types/` (reserved for persisted entities and the event contract)

