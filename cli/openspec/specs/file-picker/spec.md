# file-picker Specification

## Purpose

The multi-select file browser on `DynamicList` — directory navigation, in-folder filtering, the INSERT/NORMAL keyboard model, selection review — and its wiring into the analysis input flows (new analysis, manage inputs).

## Requirements

### Requirement: FilePicker composes DynamicList in multi mode

The system SHALL provide `FilePicker` in `src/tui/components/dialog/` (a content dialog — it lives with the dialog family, not beside the pure list primitives): a `DialogPanel` containing a breadcrumb line, a filter `TextInput`, and a `DynamicList` in `multi` mode over the current directory's entries. Props: `rootPath` (absolute; browsing opens here), `selectedPaths: ReadonlySet<string>` (seed, canonicalized on intake), `confirmLabel`, `requireSelection?`, `onConfirm(absolutePaths: string[])`, `onCancel()`. Directory navigation SHALL use the list's `onAction` interceptor: enter on a directory row descends instead of confirming.

#### Scenario: Listing renders through DynamicList

- **WHEN** the picker opens
- **THEN** the current directory's rows render in a multi-mode `DynamicList` with ●/○ gutters, and navigating into a folder replaces the reactive items

#### Scenario: Enter is overloaded by row kind

- **WHEN** the cursor is on a directory row and the user presses enter
- **THEN** the picker descends into it (no confirm); on a file row, enter confirms the batch

### Requirement: Directory listing semantics

The listing SHALL read the current directory with `withFileTypes` dirents, sort directories first then files (each group case-insensitively alphabetical), classify a symlink-to-directory as a directory (broken symlinks degrade to file rows), and canonicalize the cwd on descent. A symlink entry's row value SHALL be its canonical (realpath) target — the selection space is canonical (`classifyInputPath` stores realpaths), so an uncanonical row value would render a recorded input unchecked. An unreadable directory SHALL NOT crash the picker: it renders the error as the empty-state text and the user ascends. A synthetic `..` row SHALL be prepended when the filter is empty; it SHALL be hidden while a filter query is active, SHALL NOT be toggleable, and SHALL render no selection gutter even when the parent directory it points at is in the selection.

#### Scenario: Dirs-first ordering

- **WHEN** a folder holds files and subfolders
- **THEN** subfolders list first, each group alphabetically (case-insensitive)

#### Scenario: Unreadable folder degrades

- **WHEN** the user descends into a directory that cannot be read
- **THEN** the picker shows the read error as the list's empty-state line and remains usable

#### Scenario: Dot-dot is navigation-only

- **WHEN** the user presses space on the `..` row
- **THEN** nothing is selected; enter on `..` ascends to the parent

#### Scenario: Symlink rows honor a canonical seed

- **WHEN** a recorded input is reachable in the listing only through a symlink entry
- **THEN** the symlink's row renders ● because its value is the canonical target the seed holds

#### Scenario: Dot-dot never looks selected

- **WHEN** the user toggles `./data` and descends into `./data/ml`
- **THEN** the `..` row (whose value is `./data`) renders a blank gutter, not ●

### Requirement: Selection is absolute-path based and survives navigation

The working selection SHALL be a set of canonicalized absolute paths: toggling an entry then navigating elsewhere keeps it selected, and directories are first-class selectable entries (a whole-subtree reference). Seeded `selectedPaths` SHALL be canonicalized so membership checks match the listing's constructed paths. On confirm, the picker SHALL hand back the selection as absolute paths without collapsing or reclassifying; when `requireSelection` is set and the selection is empty, confirm SHALL be refused with a warning notice instead of closing.

#### Scenario: Selection survives navigation

- **WHEN** the user toggles `./data`, descends into `./data/ml`, and ascends
- **THEN** `./data` still shows ● and is included on confirm

#### Scenario: Empty confirm refused when required

- **WHEN** `requireSelection` is set and the user confirms with nothing selected
- **THEN** a warning notice appears and the picker stays open

### Requirement: INSERT/NORMAL keyboard model

The picker SHALL run the app's INSERT/NORMAL pattern: INSERT (filter input focused) passes keys to the input, with ↑/↓ and ctrl+p/n still moving the cursor and esc blurring to NORMAL; NORMAL (input blurred, the mount default) enables space (toggle), enter (descend/confirm), `c` (confirm the batch regardless of the cursor row — enter is overloaded by row kind, so a listing whose every visible row is a directory would otherwise offer no confirm path), ← (ascend to the parent) / → (descend into the cursor directory), `i` (focus input), `a` (toggle hidden dot-entries), `s` (review current selection for quick deselection), `o` (open the cursor row's folder in the OS explorer — a missing opener degrades to an error notice, never a crash), and esc (cancel). The multi-list's space binding SHALL be gated off while the input is focused so space types a space. The footer SHALL show the mode word, the NORMAL/INSERT key hints, and the selection count.

#### Scenario: Space is mode-dependent

- **WHEN** the user presses space in INSERT mode
- **THEN** a space character enters the filter; in NORMAL mode the cursor row toggles

#### Scenario: Review mode lists the selection

- **WHEN** the user presses `s` in NORMAL mode with a non-empty selection
- **THEN** a list of the selected paths (root-relative when under the root) opens for deselection, returning to browsing when dismissed or emptied

#### Scenario: Confirm from a directory-only listing

- **WHEN** every visible row is a directory (or `..`), the user has toggled entries, and presses `c`
- **THEN** the batch confirms — enter on the same cursor row would have descended instead

#### Scenario: Confirm with an empty filter result

- **WHEN** a filter matches nothing but the accumulated selection is non-empty and the user presses enter
- **THEN** the batch confirms (the multi list hands back its selection even with zero visible rows)

### Requirement: Picker wiring into analysis flows

The new-analysis flow SHALL open `FilePicker` seeded empty with `requireSelection` (inputs are user-driven — `createAnalysis` enrolls none by default, so the picker gathers them explicitly), and the add-inputs flow SHALL open it seeded with the analysis's existing inputs (clearing all is legitimate). The add-inputs confirm SHALL apply the diff adds-first via `applyInputsDiff`: the add batch is all-or-nothing, and the removals run ONLY when the adds succeeded — a failed add batch must not still strip the unchecked rows. Input mutations resulting from confirm SHALL emit input-change bus events so the sidebar refreshes without a reload.

#### Scenario: New analysis requires an explicit selection

- **WHEN** the user creates an analysis through the TUI flow
- **THEN** the picker opens with nothing pre-selected and refuses an empty confirm

#### Scenario: Add inputs seeds existing state

- **WHEN** the user opens add-inputs on an analysis with recorded inputs
- **THEN** those inputs render pre-checked, and confirming a changed set adds/removes accordingly with the sidebar updating via bus events

#### Scenario: A failed add batch leaves existing inputs intact

- **WHEN** the user unchecks an input and adds a path that fails classification (deleted between pick and confirm)
- **THEN** nothing is removed and nothing is added — the analysis's inputs are exactly what they were before the confirm
