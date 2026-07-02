# file-picker — delta

## ADDED Requirements

### Requirement: FilePicker composes DynamicList in multi mode

The system SHALL provide `FilePicker` in `src/tui/components/`: a `DialogPanel` containing a breadcrumb line, a filter `TextInput`, and a `DynamicList` in `multi` mode over the current directory's entries. Props: `rootPath` (absolute; browsing opens here), `selectedPaths: ReadonlySet<string>` (seed, canonicalized on intake), `confirmLabel`, `requireSelection?`, `onConfirm(absolutePaths: string[])`, `onCancel()`. Directory navigation SHALL use the list's `onAction` interceptor: enter on a directory row descends instead of confirming.

#### Scenario: Listing renders through DynamicList

- **WHEN** the picker opens
- **THEN** the current directory's rows render in a multi-mode `DynamicList` with ●/○ gutters, and navigating into a folder replaces the reactive items

#### Scenario: Enter is overloaded by row kind

- **WHEN** the cursor is on a directory row and the user presses enter
- **THEN** the picker descends into it (no confirm); on a file row, enter confirms the batch

### Requirement: Directory listing semantics

The listing SHALL read the current directory with `withFileTypes` dirents, sort directories first then files (each group case-insensitively alphabetical), classify a symlink-to-directory as a directory (broken symlinks degrade to file rows), and canonicalize the cwd on descent. An unreadable directory SHALL NOT crash the picker: it renders the error as the empty-state text and the user ascends. A synthetic `..` row SHALL be prepended when the filter is empty; it SHALL be hidden while a filter query is active and SHALL NOT be toggleable.

#### Scenario: Dirs-first ordering

- **WHEN** a folder holds files and subfolders
- **THEN** subfolders list first, each group alphabetically (case-insensitive)

#### Scenario: Unreadable folder degrades

- **WHEN** the user descends into a directory that cannot be read
- **THEN** the picker shows the read error as the list's empty-state line and remains usable

#### Scenario: Dot-dot is navigation-only

- **WHEN** the user presses space on the `..` row
- **THEN** nothing is selected; enter on `..` ascends to the parent

### Requirement: Selection is absolute-path based and survives navigation

The working selection SHALL be a set of canonicalized absolute paths: toggling an entry then navigating elsewhere keeps it selected, and directories are first-class selectable entries (a whole-subtree reference). Seeded `selectedPaths` SHALL be canonicalized so membership checks match the listing's constructed paths. On confirm, the picker SHALL hand back the selection as absolute paths without collapsing or reclassifying; when `requireSelection` is set and the selection is empty, confirm SHALL be refused with a warning notice instead of closing.

#### Scenario: Selection survives navigation

- **WHEN** the user toggles `./data`, descends into `./data/ml`, and ascends
- **THEN** `./data` still shows ● and is included on confirm

#### Scenario: Empty confirm refused when required

- **WHEN** `requireSelection` is set and the user confirms with nothing selected
- **THEN** a warning notice appears and the picker stays open

### Requirement: INSERT/NORMAL keyboard model

The picker SHALL run the app's INSERT/NORMAL pattern: INSERT (filter input focused) passes keys to the input, with ↑/↓ and ctrl+p/n still moving the cursor and esc blurring to NORMAL; NORMAL (input blurred, the mount default) enables space (toggle), enter (descend/confirm), ← (ascend to the parent) / → (descend into the cursor directory), `i` (focus input), `a` (toggle hidden dot-entries), `s` (review current selection for quick deselection), `o` (open the cursor row's folder in the OS explorer), and esc (cancel). The multi-list's space binding SHALL be gated off while the input is focused so space types a space. The footer SHALL show the mode word, the NORMAL/INSERT key hints, and the selection count.

#### Scenario: Space is mode-dependent

- **WHEN** the user presses space in INSERT mode
- **THEN** a space character enters the filter; in NORMAL mode the cursor row toggles

#### Scenario: Review mode lists the selection

- **WHEN** the user presses `s` in NORMAL mode with a non-empty selection
- **THEN** a list of the selected paths (root-relative when under the root) opens for deselection, returning to browsing when dismissed or emptied

### Requirement: Picker wiring into analysis flows

The new-analysis flow SHALL open `FilePicker` seeded empty with `requireSelection` (breaking the silent whole-cwd default), and the add-inputs flow SHALL open it seeded with the analysis's existing inputs (clearing all is legitimate). Input mutations resulting from confirm SHALL emit input-change bus events so the sidebar refreshes without a reload.

#### Scenario: New analysis requires an explicit selection

- **WHEN** the user creates an analysis through the TUI flow
- **THEN** the picker opens with nothing pre-selected and refuses an empty confirm

#### Scenario: Add inputs seeds existing state

- **WHEN** the user opens add-inputs on an analysis with recorded inputs
- **THEN** those inputs render pre-checked, and confirming a changed set adds/removes accordingly with the sidebar updating via bus events
