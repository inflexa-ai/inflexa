# tui-components Specification

## Purpose
TBD - created by archiving change extract-tui-components. Update Purpose after archive.
## Requirements
### Requirement: Shared TUI component directory with a membership rule

The system SHALL house shared, domain-agnostic TUI widgets under `src/tui/components/`. A widget SHALL belong in `components/` only when it (a) imports nothing beyond `theme` and `@opentui/*` / `solid-js` — no imports from `src/modules/`, `src/db/`, or other domain code — and (b) has two or more callers. Widgets SHALL be one component per file (no barrel/index re-exports), and callers SHALL import each component from its own file. A palette- or feature-specific adapter (e.g. `CommandPalette`, which maps `Command` domain objects) SHALL NOT live in `components/`; it stays in the `tui/` app-shell.

The chat TUI's app-shell **composition kit** is distinct from reusable widgets and SHALL live in `src/tui/layout/` (see the `tui-layout` capability), distinguished by **role** rather than by import shape: `components/` holds reusable, domain-agnostic widgets, while `layout/` holds the structural parts the screen is assembled from. A kit part SHALL stay in `layout/` even when it would otherwise satisfy the `components/` rule — for example a generic, multi-caller `StatusBar` that imports only `theme` belongs in `layout/`, not `components/`, because it is shell composition.

#### Scenario: Generic widget lives in components/

- **WHEN** a widget imports only `theme` + opentui/solid and has ≥2 callers
- **THEN** it resides in `src/tui/components/` as its own file, imported directly by each caller

#### Scenario: Domain-coupled adapter stays out of components/

- **WHEN** a component imports domain types (e.g. `Command`, an `Analysis`) or module code
- **THEN** it stays in the `tui/` app-shell, not in `components/`

#### Scenario: Composition kit lives in layout/, not components/

- **WHEN** a part is one of the app-shell composition kit (status bar, message block, input bar, sidebar) — even a generic, multi-caller one like `StatusBar`
- **THEN** it resides in `src/tui/layout/`, not `src/tui/components/`, because the two directories are distinguished by role (shell composition vs reusable widget)

### Requirement: DialogPanel chrome shell

The system SHALL provide a `DialogPanel` component in `src/tui/components/` that owns the shared dialog chrome: a bordered box painted with the raised panel background (`theme().bgRaised`), border style `stroke.overlay` (rounded), an accent-colored (`theme().accent`) title, and `paddingLeft`/`paddingRight` of 1. It SHALL accept `title`, a named `size` preset (a `DialogSize` key — no raw width/height escape hatches), an optional `tone` (`"default" | "danger"`), an optional `padY` flag (top+bottom padding of 1), an optional `footer` string, and `children`. Sizing SHALL be applied from the `dialogSize` design-system presets: fixed `width` with `maxWidth` clamp, and content-driven height under `maxHeight` for the non-`xl` tiers (see the `tui-design-tokens` capability). When `tone` is `"danger"`, the panel SHALL use `stroke.danger` (double) with the error border color — the chrome for destructive confirmations. When `footer` is set, `DialogPanel` SHALL render it as the last child as a single muted (`theme().fgMuted`) hint line inside a full-width box painted with the panel background (the scrollbox-overlap remedy). `DialogPanel` SHALL be pure chrome — it SHALL NOT own keyboard handling or focus; keyboard behavior belongs to the composing widget and the dialog host.

#### Scenario: Renders the shared chrome

- **WHEN** a widget renders its body inside `DialogPanel` with a `title` and `footer`
- **THEN** the panel shows the rounded bordered `bgRaised` frame at its preset's clamped dimensions, the accent title, the body, and the muted footer line as the last row

#### Scenario: Footer is optional

- **WHEN** `DialogPanel` is given no `footer`
- **THEN** no footer line is rendered

#### Scenario: Danger tone signals a destructive dialog

- **WHEN** a destructive confirmation renders with `tone="danger"`
- **THEN** the panel border is the double `stroke.danger` style in the error color

#### Scenario: Does not capture the keyboard

- **WHEN** a dialog composed from `DialogPanel` is open
- **THEN** keyboard and focus behavior is driven by the composing widget and the dialog host, not by `DialogPanel`

### Requirement: Relocated dialog widgets compose DialogPanel without behavior change

`SelectDialog` (with `SelectItem`; its fuzzy ranking is delegated through the list primitives to the shared `rankBy` in `src/lib/fuzzy.ts`, called with a title-2×/category-1 weighted field list — no scorer or ranker is defined in the component), `PromptDialog`, and `ResultsDialog` SHALL live in `src/tui/components/`, each in its own file, and SHALL render their body through `DialogPanel`. Their observable behavior — filtering/ranking, navigation keys, submit/cancel/close keys, focus-on-mount, empty-state messages, and footer hint text — SHALL follow the `select-dialog` capability for `SelectDialog` and remain unchanged for `PromptDialog`/`ResultsDialog`.

`SelectDialog` SHALL delegate list rendering, navigation, and selection to `FixedList` (see the `list-primitives` capability) and SHALL own the filter `TextInput`, passing its value down as the list's `query`. The highlighted-row description line renders inside the list body (above the footer) per `list-primitives`.

`FilePicker` SHALL delegate its list rendering and selection management to `DynamicList` in `"multi"` mode, retaining only filesystem-specific concerns: cwd/breadcrumb signals, directory navigation, INSERT/NORMAL keyboard modes, hidden-file toggle, review mode, and open-in-explorer. `FilePicker` SHALL use `onAction` to intercept enter on directory rows for navigation instead of confirm.

`SelectDialog` SHALL use the shared `TextInput` component (with `chrome="bare"`) for its filter input instead of a raw opentui `<input>` element. `PromptDialog` SHALL select its text-entry primitive with a `multiline` prop: when `multiline` is false (the default), it SHALL render the shared `TextInput` component (`chrome="bare"` — the dialog panel border is the sole chrome) with enter-to-submit and NO newline chord; when `multiline` is true, it SHALL render the shared `TextArea` component (`chrome="bare"`) with the submit/newline chords and `height` semantics intact. In neither case SHALL an INSERT/NORMAL mode word appear inside a modal dialog. `ExportOptionsDialog` SHALL use the shared `TextArea` component (with `chrome="bare"`) for its optional text field instead of a raw opentui `<textarea>` element.

`ResultsDialog` SHALL render its line list inside a `ScrollPane` (see the `scroll-pane` capability) instead of a raw focused `<scrollbox>`, inheriting the canonical scroll key set (`gg`/`G`/`j`/`k`/arrows/`ctrl+d`/`ctrl+u`/page/home/end at ScrollPane step sizes). Its footer hint SHALL describe the scroll keys from the shared chord definitions (via `chordLabel`), not hand-written key text.

#### Scenario: SelectDialog single-mode behavior

- **WHEN** a caller renders `SelectDialog` from `src/tui/components/select_dialog.tsx` without a `mode` prop
- **THEN** fuzzy filtering (headers preserved), Up/Down + Ctrl+P/Ctrl+N navigation, Enter-to-select, Esc-to-cancel, and the grouped/empty-state rendering behave per the `select-dialog` capability

#### Scenario: DynamicList multi-mode used by FilePicker

- **WHEN** `FilePicker` renders its file listing
- **THEN** it uses `DynamicList` with `mode="multi"`, passing filesystem rows as reactive items and using `onAction` to handle directory navigation on enter

#### Scenario: Rendering strategy follows the list primitives

- **WHEN** `SelectDialog` or `FilePicker` renders list rows inside the scroll surface
- **THEN** the underlying primitive applies its specced strategy — `<For>` in `FixedList` (stable references), `<Index>` in `DynamicList` (positional updates)

#### Scenario: SelectDialog uses TextInput

- **WHEN** `SelectDialog` renders its filter input
- **THEN** it uses the shared `TextInput` component with `chrome="bare"`, not a raw opentui `<input>`

#### Scenario: Single-line prompt uses TextInput

- **WHEN** `PromptDialog` renders without `multiline` (the default)
- **THEN** it renders the shared `TextInput` (`chrome="bare"`): enter submits, no key inserts a newline, no second border, and no mode word is shown

#### Scenario: Multiline prompt opts into TextArea

- **WHEN** `PromptDialog` renders with `multiline` set
- **THEN** it renders the shared `TextArea` (`chrome="bare"`) with the submit chord, the newline chord, and the `height` prop honored

#### Scenario: ExportOptionsDialog uses TextArea

- **WHEN** `ExportOptionsDialog` renders its optional text field
- **THEN** it uses the shared `TextArea` component with `chrome="bare"`, not a raw opentui `<textarea>`

#### Scenario: PromptDialog and ResultsDialog relocated

- **WHEN** a caller needs a single-line prompt or a read-only results list
- **THEN** it imports `PromptDialog` / `ResultsDialog` from `src/tui/components/`, and Enter-submit / Esc-cancel and Esc-q-Enter-close behave exactly as before

#### Scenario: ResultsDialog scrolls via ScrollPane

- **WHEN** `ResultsDialog` is open with more lines than fit the viewport
- **THEN** `gg`/`G`/`j`/`k`/arrows/page keys scroll the list at ScrollPane step sizes, and the footer hint text is derived from the shared chord definitions

#### Scenario: Footer hints reflect the dialog mode

- **WHEN** `SelectDialog` renders in single or multi mode
- **THEN** its footer shows mode-appropriate hints (single: move/select/cancel; multi: toggle/confirm/cancel plus selection count), all labels derived via `chordLabel`

### Requirement: command_palette.tsx is palette-only

After the move, `src/tui/command_palette.tsx` SHALL contain only the palette concerns: the single dispatch verb `runCommand` and the `CommandPalette` adapter. It SHALL NOT define `PromptDialog` or `ResultsDialog`. Every former importer of those widgets SHALL import them from `src/tui/components/` instead, with no compatibility shim or re-export left behind.

#### Scenario: Shells no longer defined in the palette file

- **WHEN** `command_palette.tsx` is read after the change
- **THEN** it defines `runCommand` and `CommandPalette` only, and exports no dialog shells

#### Scenario: No shim left behind

- **WHEN** the codebase is searched for re-exports of the moved widgets from `command_palette.tsx` or the old `select_list.tsx` path
- **THEN** none exist; every importer points at `src/tui/components/`

### Requirement: Single shared Notice type and color mapping

The system SHALL define the `Notice` type (`{ kind: "info" | "warn" | "error"; text: string }`) exactly once, in `src/tui/theme.ts`, together with a `noticeColor(kind: Notice["kind"]): string` helper that reads `theme()` reactively and returns the semantic color for the kind. They live in `theme.ts` (the reactive theme accessor) because a notice kind maps onto a matching palette role — `noticeColor` is a theme accessor. `commands.tsx` (the `CommandContext.notify` signature), `app.tsx`, and `app_config.tsx` SHALL import them from `src/tui/theme.ts`; the duplicate `Notice` definitions and the inlined/duplicated color mapping SHALL be removed. `noticeColor` SHALL be layout-agnostic — callers decide whether to use the returned color as a background or foreground. No `NoticeBanner` component SHALL be extracted, because the screens render notices with different layouts.

#### Scenario: One definition, three importers

- **WHEN** `Notice` or `noticeColor` is needed in `commands.tsx`, `app.tsx`, or `app_config.tsx`
- **THEN** it is imported from `src/tui/theme.ts`, and no other file defines `Notice`

#### Scenario: Color mapping is reused, layout is not

- **WHEN** `app.tsx` colors its transient banner and `app_config.tsx` colors its in-flow notice text
- **THEN** both derive the color from `noticeColor(kind)` while keeping their own distinct layouts

#### Scenario: Notice type stays out of src/types/

- **WHEN** deciding where `Notice` lives
- **THEN** it is in the `tui/` presentation layer (`src/tui/theme.ts`), not `src/types/` (reserved for persisted entities and the event contract)

