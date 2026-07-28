## ADDED Requirements

### Requirement: Initial cursor seeding by value

Both lists SHALL accept an optional `initialValue?: T`. At mount, the cursor SHALL seed onto the row in the flat grouped projection whose `value` strict-equals (`===`) it; when the prop is absent or no row matches, the cursor SHALL start at row 0 as before. Seeding SHALL take effect before mount-time effects run, so the first `onCursorChange` fires with the seeded row and scroll-into-view brings it (and its group header, when it starts a group) into view. The seed is mount-time only: it SHALL NOT override the existing cursor-reset behavior — a new query still moves the cursor to the best match, and a replaced `DynamicList` items array still restarts from the top.

#### Scenario: Cursor opens on the seeded row

- **WHEN** a list mounts with `initialValue` matching a row's value
- **THEN** that row is the cursor row, it is scrolled into view, and the mount-time `onCursorChange` reports it

#### Scenario: Unmatched seed falls back to row 0

- **WHEN** a list mounts with an `initialValue` no row carries
- **THEN** the cursor starts at row 0

#### Scenario: Seeding does not pin the cursor

- **WHEN** the user types a query after mounting with a seeded cursor
- **THEN** the cursor moves to the best-ranked match exactly as without seeding
