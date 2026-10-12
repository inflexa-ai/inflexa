# Spec Delta

## MODIFIED Requirements

### Requirement: Directory listing semantics

The listing MUST come from the shared folder listing of the CLI. The folder list route of the local server uses the same listing.

The listing MUST read the current directory one time, with `withFileTypes` dirents. The sort MUST use the kind from that read: directories first, then each other entry. Each group MUST be in case-insensitive alphabetical order. A symlink entry MUST sort with the files, because the sort takes no `stat`.

A symlink whose target is a directory MUST still render with the trailing `/`, and it MUST open as a directory. A broken symlink degrades to a file row. The listing MUST canonicalize the cwd on descent.

The row value of a symlink entry MUST be its canonical (realpath) target. The selection space is canonical, because `classifyInputPath` stores realpaths. An uncanonical row value would thus render a recorded input unchecked.

An unreadable directory MUST NOT crash the picker. The picker renders the error as the empty-state text, and the user ascends.

A synthetic `..` row MUST come first when the filter is empty. It MUST be hidden while a filter query is active. It MUST NOT be toggleable. It MUST render no selection gutter, even when the parent directory that it points at is in the selection.

#### Scenario: Dirs-first ordering

- **WHEN** a folder holds files and subfolders
- **THEN** subfolders list first, each group alphabetically (case-insensitive)

#### Scenario: A symlink to a folder sorts with the files and still opens

- **GIVEN** a folder that holds the subfolder `beta`, the files `alpha.txt` and `zeta.txt`, and a symlink `ext` to a folder
- **WHEN** the picker lists it
- **THEN** the rows are `beta/`, `alpha.txt`, `ext/`, and `zeta.txt`, in this order
- **AND** enter on `ext/` descends into the target folder

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

### Requirement: The listing resolves entry metadata with one stat for each entry

The listing MUST take its entry facts from the shared folder listing. It MUST take one
`stat` for each entry that it lists, and one `readlink` for each symbolic link.
It MUST take no `access` call. The `Stats` object gives the size, the modification
time, the mode bits, the owner uid, and the owner gid.

The listing MUST derive readability from those mode bits and owner ids, against the ids
of the process. It MUST read `process.getuid()`, `process.getgid()`, and
`process.getgroups()` one time for each mount of the picker, and never for each entry.

A `stat` that fails MUST NOT remove the row. That row lists with no metadata.

The listing MUST apply an entry ceiling. Above the ceiling it lists the names alone, and
the footer reports the absent metadata. It takes no `stat` for an entry that is not a
symbolic link. A symbolic link still takes its `stat`, because a link to a directory
opens as a directory.

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

The listing MUST give the rows and their metadata in one update. The picker MUST NOT fill
the metadata after the rows render. A late fill mints the items array again, and the list
engine then moves the cursor to row 0.

The reads MUST run off the event loop, with a fixed count of `stat` calls in flight. A
read that lands after the user leaves its folder MUST NOT replace the rows of the newer
folder.

#### Scenario: One syscall for each entry

- **WHEN** the picker lists a directory below the entry ceiling
- **THEN** it takes one `stat` for each entry and no `access` call

#### Scenario: A failed stat keeps the row

- **WHEN** an entry disappears between the `readdir` and its `stat`
- **THEN** the row still lists, with no size, no date, and no permission bits
- **AND** its name starts in the same column as the name of each row beside it

#### Scenario: A large directory skips the metadata

- **WHEN** the directory holds more entries than the ceiling
- **THEN** the rows carry names alone, no `stat` runs for an entry that is not a symbolic link, and the footer reports it

#### Scenario: A failed stat is not a large folder

- **GIVEN** a directory below the ceiling that holds one broken symbolic link
- **WHEN** the picker lists it
- **THEN** the row lists with no metadata, and the footer reports no ceiling

#### Scenario: The process ids are read once

- **WHEN** the picker lists a directory of 400 entries
- **THEN** `process.getuid`, `process.getgid`, and `process.getgroups` each run one time
