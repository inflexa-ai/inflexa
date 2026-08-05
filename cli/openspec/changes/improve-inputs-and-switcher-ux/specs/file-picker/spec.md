## ADDED Requirements

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

The fill MUST be synchronous. The picker MUST NOT fill the metadata asynchronously. A
late fill mints the items array again, and the list engine then moves the cursor to row 0.

#### Scenario: One syscall for each entry

- **WHEN** the picker lists a directory below the entry ceiling
- **THEN** it takes one `statSync` for each entry and no `accessSync` call

#### Scenario: A failed stat keeps the row

- **WHEN** an entry disappears between the `readdirSync` and its `statSync`
- **THEN** the row still lists, with no size, no date, and no permission bits

#### Scenario: A large directory skips the metadata

- **WHEN** the directory holds more entries than the ceiling
- **THEN** the rows carry names alone, no `stat` runs, and the footer reports it

#### Scenario: The process ids are read once

- **WHEN** the picker lists a directory of 400 entries
- **THEN** `process.getuid`, `process.getgid`, and `process.getgroups` each run one time

### Requirement: An entry row carries its size, its date, and its permission bits

An entry row MUST carry a `hint` with the permission bits, the size, and the modification
date. The list engine renders a `hint` inline, after the title, on the same row.

A directory row MUST carry no size field. A member count needs one `readdir` for each
directory row, which breaks the syscall budget above. Measured over 467 directories, that
pass cost 54.46 ms cold against 1.65 ms for the `stat` pass.

The size MUST render through `Number.formatBytes`. The date MUST render through the
native `toLocaleString` in its compact form, and never as a relative age.

The row MUST use `hint`, and not `meta`, because an entry name is short. Thus a row stays
one line and the listing keeps its height.

An entry that the process cannot read MUST render in the warning color of the theme. The
mark MUST NOT refuse the selection. The authoritative refusal belongs to staging.

On Windows the row MUST carry no permission bits and no readability mark. `process.getuid`
does not exist there, and Node reports synthetic mode bits.

#### Scenario: A file row is comparable to its siblings

- **WHEN** a folder holds two data files of different sizes and ages
- **THEN** each row shows its own permission bits, its size, and its date

#### Scenario: A directory row carries no size

- **WHEN** the listing holds a directory and a file
- **THEN** the directory row shows its permission bits and its date, and no size

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
