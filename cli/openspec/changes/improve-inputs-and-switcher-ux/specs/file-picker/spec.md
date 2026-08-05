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

An entry row MUST carry the permission bits in its `prefix`, LEFT of the name. This is the
reading order of `ls -l`, and a shell user already has that habit. The triple is always 9
characters, thus the column aligns with no padding.

An entry row MUST carry the size and the modification date in its `hint`, right of the
name. The list engine renders a `hint` inline, at the right edge of the row.

The size MUST render through `Number.formatBytes`, right-aligned in a field as wide as the
widest size of that listing. The eye compares a magnitude down a column, thus a ragged
field defeats the purpose of the number.

The date MUST render through the native `toLocaleString`, with `year`, `month`, `day`,
`hour`, and `minute` each set to `2-digit`. It MUST never render as a relative age.

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
