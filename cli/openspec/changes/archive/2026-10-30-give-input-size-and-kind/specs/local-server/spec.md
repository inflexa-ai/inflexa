## ADDED Requirements

### Requirement: An input of an analysis gives its size and its kind

Each `InputView` that the server sends MUST carry `size` and `kind`. `GET {A}/inputs`, `POST {A}/inputs`, `PUT {A}/inputs`, and `POST {A}/inputs/remove` send an `InputView` for each input that they name.

- `size` is the byte count of the file at the absolute path of the input, from one `stat` that follows links. It MUST be `null` for a folder, for an input with no absolute path, and for a path whose `stat` fails.
- `kind` is the kind of the name of the stored path, from the extension map of the file system routes. It MUST be `null` for a folder, and for an extension that the map does not name.

An input is a folder when its `stat` gives a folder. When the input has no `stat`, its stored `isDir` decides.

The server MUST read at most one `stat` for each input of a response, in a queue of fixed width. Thus the reads of `GET {A}/inputs` stay in the limit of `perPage`. A failed `stat` MUST NOT fail the response.

#### Scenario: A file, a folder, and a missing path

- **GIVEN** analysis `a1` with the declared inputs `/data/counts.csv`, a file of 1204 bytes, `/data/runs`, a folder, and `/data/gone.csv`, where no entry exists
- **WHEN** a client sends `GET {A}/inputs`
- **THEN** `/data/counts.csv` has `size` 1204 and `kind` `table`
- **AND** `/data/runs` has `size` `null` and `kind` `null`
- **AND** `/data/gone.csv` has `size` `null` and `kind` `table`

#### Scenario: A file with no mapped extension

- **GIVEN** analysis `a1` with the declared input `/data/notes.zzz`, a file of 12 bytes, whose extension the map does not name
- **WHEN** a client sends `GET {A}/inputs`
- **THEN** the input has `size` 12 and `kind` `null`

#### Scenario: An added input gives its size and its kind

- **GIVEN** the file `/data/counts.csv` of 1204 bytes
- **WHEN** a client sends `POST {A}/inputs` with that path
- **THEN** the added input has `size` 1204 and `kind` `table`
