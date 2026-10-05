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

### Requirement: The listing resolves entry metadata with one stat for each entry

The listing MUST take one `statSync` for each entry that it lists. It MUST take no
`accessSync` call. The `Stats` object gives the size, the modification time, the mode
bits, the owner uid, and the owner gid.

The listing MUST derive readability from those mode bits and owner ids, against the ids
of the process. It MUST read `process.getuid()`, `process.getgid()`, and
`process.getgroups()` one time for each mount of the picker, and never for each entry.

A `stat` that fails MUST NOT remove the row. That row lists with no metadata.

The listing MUST apply an entry ceiling. Above the ceiling it lists the names alone, it
takes no `stat`, and the footer reports the absent metadata.

The listing MUST carry the ceiling decision as a flag beside its rows. The footer MUST
report from that flag. It MUST NOT infer the decision from the rows, because a folder that
holds one broken symbolic link also gives rows with no metadata. Such a folder is not
large, thus a footer that names the ceiling states a cause that is not the one at hand.

The listing MUST format the size and the date ONE time for each row, and it MUST keep the
two strings. The items of the picker are built again on each keystroke of the filter. A
format at that point costs the whole listing for one typed character.

The date MUST come from one `Intl.DateTimeFormat` for the process. A call to
`toLocaleString` with options builds a formatter each time, which measured 48.6 ms over
2000 rows against 2.5 ms for the shared formatter.

The fill MUST be synchronous. The picker MUST NOT fill the metadata asynchronously. A
late fill mints the items array again, and the list engine then moves the cursor to row 0.

#### Scenario: One syscall for each entry

- **WHEN** the picker lists a directory below the entry ceiling
- **THEN** it takes one `statSync` for each entry and no `accessSync` call

#### Scenario: A failed stat keeps the row

- **WHEN** an entry disappears between the `readdirSync` and its `statSync`
- **THEN** the row still lists, with no size, no date, and no permission bits
- **AND** its name starts in the same column as the name of each row beside it

#### Scenario: A large directory skips the metadata

- **WHEN** the directory holds more entries than the ceiling
- **THEN** the rows carry names alone, no `stat` runs, and the footer reports it

#### Scenario: A failed stat is not a large folder

- **GIVEN** a directory below the ceiling that holds one broken symbolic link
- **WHEN** the picker lists it
- **THEN** the row lists with no metadata, and the footer reports no ceiling

#### Scenario: The process ids are read once

- **WHEN** the picker lists a directory of 400 entries
- **THEN** `process.getuid`, `process.getgid`, and `process.getgroups` each run one time

### Requirement: An entry row carries its size, its date, and its permission bits

An entry row MUST carry the permission bits in its `prefix`, LEFT of the name. This is the
reading order of `ls -l`, and a shell user already has that habit. The triple is always 9
characters, thus the column aligns with no padding.

A row with no metadata, in a listing that has metadata, MUST hold the column as blanks. A
name that starts 9 columns left reads as a mode string, and not as an absent one. It also
breaks the alignment that each other row of the listing wants.

A listing with no metadata at all MUST drop the column. An empty column on each row spends
the width of the name to say nothing.

An entry row MUST carry the size and the modification date in its `hint`, right of the
name. The list engine renders a `hint` inline, at the right edge of the row.

The size MUST render through `Number.formatBytes`, right-aligned in a field as wide as the
widest size of that listing. The eye compares a magnitude down a column, thus a ragged
field defeats the purpose of the number.

The date MUST render with `year`, `month`, `day`, `hour`, and `minute` each set to
`2-digit`. It MUST never render as a relative age.

That form is fixed-width, and the compact `dateStyle` form is not. Measured in en-US, the
compact form gives 15 to 17 columns and this form gives 18. Thus the date column aligns
with no padding of its own, and the value stays locale-ordered.

A directory row MUST carry no size. A member count needs one `readdir` for each directory
row, which breaks the syscall budget above. Measured over 467 directories, that pass cost
54.46 ms cold against 1.65 ms for the `stat` pass.

The blank size field of a directory row MUST span its separator too. Thus the date of a
directory row lands in the same column as the date of a file row beside it.

The row MUST use `hint`, and not `meta`, because an entry name is short. Thus a row stays
one line and the listing keeps its height.

An entry that the process cannot read MUST render in the warning color of the theme. The
mark MUST NOT refuse the selection. The authoritative refusal belongs to staging.

On Windows the row MUST carry no permission bits and no readability mark. `process.getuid`
does not exist there, and Node reports synthetic mode bits.

#### Scenario: A file row is comparable to its siblings

- **WHEN** a folder holds two data files of different sizes and ages
- **THEN** each row shows its own permission bits, its size, and its date

#### Scenario: The mode sits left of the name

- **WHEN** the picker renders a file row
- **THEN** the permission triple renders before the name, and it never ranks in the filter

#### Scenario: The columns land under each other

- **GIVEN** a folder that holds a 600-byte file and a 140-kilobyte file
- **WHEN** the picker lists it
- **THEN** the two separators share one column, and the two dates start in one column

#### Scenario: A directory row carries no size

- **WHEN** the listing holds a directory and a file
- **THEN** the directory row shows its permission bits and its date, and no size
- **AND** its date starts in the same column as the date of the file row

#### Scenario: An unreadable entry is marked

- **GIVEN** a file whose mode bits deny read to this user, this group, and other users
- **WHEN** the picker lists its folder
- **THEN** the row renders in the warning color, and space still toggles it

#### Scenario: Windows renders no permission column

- **WHEN** the picker lists a folder on Windows
- **THEN** the row carries the size and the date, with no permission bits and no mark

### Requirement: The picker renders no cursor detail line

The picker MUST set no `description` on a row. Thus the list renders no bottom detail
line, and the listing keeps the two rows that the painted detail box costs.

The picker MUST NOT give the full path of the cursor row this way. The breadcrumb gives
the location, and REVIEW mode lists the whole selection with root-relative paths.

#### Scenario: No detail line under the listing

- **WHEN** the cursor moves to any row
- **THEN** no bottom detail line renders, and the list keeps its full height
