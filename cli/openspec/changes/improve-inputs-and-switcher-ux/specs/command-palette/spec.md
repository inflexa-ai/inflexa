## ADDED Requirements

### Requirement: The Switch analysis picker groups its rows by anchor

The picker MUST group its rows on the anchor id of the analysis, and MUST title each
group with the anchor folder. The path MUST render in its contracted form, through
`contractHome`.

The group key MUST be the anchor id, and never the path. Two live anchors can hold one
cached path: a user deletes a `.inflexa/id` marker and makes a new one in that folder.
Keyed on the path the two groups merge, and a dead anchor's analyses mix with the current
ones.

The anchor paths MUST come from ONE `listAnchors()` query over the local database, and
never one query for each drawn row. This matches the batched read of the token totals,
and it keeps the picker open with the harness runtime stopped.

The read MUST use the cached path directly, with no reconciliation, because the picker is
a read-only display. An anchor that the database no longer holds MUST degrade to the
wording that the provenance surface uses for an unknown folder.

Group order MUST be the first appearance in ranked order. `listRecentAnalyses` is already
sorted by recency. Thus a group carries the position of its newest analysis.

#### Scenario: Two analyses of one name are distinguishable

- **GIVEN** two analyses that carry the name `A1` in two different folders
- **WHEN** the Switch analysis picker opens
- **THEN** each row renders under the header of its own anchor folder

#### Scenario: The folder is searchable

- **WHEN** the user types part of an anchor folder into the filter
- **THEN** the analyses of that folder survive the filter, and the header stays above them

#### Scenario: One query reads every anchor

- **WHEN** the picker opens over 20 analyses
- **THEN** exactly one `listAnchors()` query runs, and no query runs for each row

#### Scenario: A missing anchor degrades

- **GIVEN** an analysis whose anchor row is gone from the database
- **WHEN** the picker opens
- **THEN** its group header reports an unknown folder, and the row stays selectable

### Requirement: The Switch analysis picker renders an absolute local date

Each row MUST carry the creation date of its analysis as an absolute local time, through
the native `toLocaleString`. A row MUST NOT carry a relative age.

The row MUST use the compact form of that call, with a short date style and a short time
style. The picker is a record listing, thus the time rule puts it on the absolute side.

The picker MUST carry a cursor detail line with the analysis id, the slug, and the full
creation date. This line is the one place that gives an unambiguous handle for the row.

#### Scenario: The row shows a date, not an age

- **WHEN** the picker renders an analysis created on 24 July 2026
- **THEN** the row shows that local date and time, and never a text such as `12d`

#### Scenario: The cursor row gives its id

- **WHEN** the cursor moves to an analysis row
- **THEN** the detail line shows that analysis's id, its slug, and its full creation date

### Requirement: The Switch analysis picker copies the analysis id

The picker MUST bind `ctrl+y` to copy the analysis id of the cursor row to the clipboard.
The copy MUST go through the shared `writeClipboard`, which emits an OSC 52 escape AND
runs the native tool. Thus the copy reaches a terminal over SSH and a graphical clipboard.

The picker MUST report the copy with a notice, as the chat surface does.

The chord MUST carry the control key, and MUST NOT be a bare printable key. The filter
input of this picker holds the focus for the whole life of the dialog, because a
single-mode dialog has no NORMAL state. Thus a bare key would enter the filter as text.

The binding MUST declare a description and a group. The WhichKey overlay reads those, thus
the key is discoverable without a footer of its own.

#### Scenario: The id reaches the clipboard

- **WHEN** the cursor is on an analysis row and the user pushes `ctrl+y`
- **THEN** that analysis's id is written to the clipboard and a notice reports the copy

#### Scenario: The filter still receives a typed `y`

- **WHEN** the filter input holds the focus and the user types `y`
- **THEN** the character enters the filter, and no copy happens
