# anchor-marker Specification

## Purpose
The on-disk `.inflexa/id` folder-identity marker: its path helper, canonicalization, validated and write-once read/write, directory-writability check, and upward discovery — a filesystem-only module that mints no ids and has no DB coupling.
## Requirements
### Requirement: Marker path helper

The system SHALL provide `markerPath(dir)` returning `join(dir, ".inflexa", "id")`, in the filesystem-only module `src/modules/anchor/marker.ts`.

#### Scenario: Marker path composition

- **WHEN** `markerPath("/data/genomics")` is called
- **THEN** it returns `/data/genomics/.inflexa/id`

### Requirement: Canonical path helper

The system SHALL provide `canonicalPathAsync(p)` resolving to the canonical absolute form of `p` (resolving symlinks where the path exists, normalizing otherwise) so anchor paths compare and store consistently. The `realpath` SHALL run off the event loop.

#### Scenario: Canonicalization is stable

- **WHEN** `canonicalPathAsync` is called twice on paths that denote the same location
- **THEN** both calls return the same canonical string

### Requirement: Validated marker read

The system SHALL provide `readMarker(dir)` returning `ResultAsync<AnchorMarker | null, MarkerError>`: the parsed `AnchorMarker` when `<dir>/.inflexa/id` exists and is valid, `null` when the file is absent, and an err when the file exists but is malformed JSON or has a `schemaVersion` other than `1`. Each read SHALL run off the event loop. A failed existence `stat` of the file (for example `ENOENT`, `ENOTDIR`, or `EACCES` on a parent) SHALL read as absent.

#### Scenario: Absent marker

- **WHEN** `<dir>/.inflexa/id` does not exist
- **THEN** `readMarker(dir)` returns `null`

#### Scenario: Valid marker

- **WHEN** `<dir>/.inflexa/id` contains `{ "schemaVersion": 1, "anchorId": "<uuidv7>" }`
- **THEN** `readMarker(dir)` returns that `AnchorMarker`

#### Scenario: Corrupt marker surfaces as an error

- **WHEN** `<dir>/.inflexa/id` contains malformed JSON or a `schemaVersion` other than `1`
- **THEN** `readMarker(dir)` returns an err rather than `null`, and never silently mints a new identity

### Requirement: Write-once marker write

The system SHALL provide `writeMarker(dir, anchorId)` that writes `<dir>/.inflexa/id` only when no valid marker exists, creating `<dir>/.inflexa/` as needed, and returns the `AnchorMarker` now on disk. The caller supplies the `anchorId` (minted inline with `randomUUIDv7()`); the marker module mints no ids. When a valid marker already exists, it SHALL be returned unchanged without rewriting; when an existing marker is corrupt, it SHALL return an err rather than overwrite. It SHALL return `ResultAsync<AnchorMarker, MarkerError>`, and its reads and writes SHALL run off the event loop.

#### Scenario: First write creates the marker

- **WHEN** `writeMarker(dir, id)` is called and no marker exists
- **THEN** `<dir>/.inflexa/id` is created with `{ schemaVersion: 1, anchorId: id }`
- **AND** the returned marker carries `id`

#### Scenario: Second write is a no-op returning the existing id

- **WHEN** `writeMarker(dir, otherId)` is called and a valid marker with `id` already exists
- **THEN** the on-disk marker still carries the original `id`
- **AND** the returned marker carries the original `id`, not `otherId`

#### Scenario: Write refuses to clobber a corrupt marker

- **WHEN** `writeMarker(dir, id)` is called and the existing marker is corrupt
- **THEN** it returns an err and does not overwrite the file

### Requirement: Directory writability check

The system SHALL provide `isDirWritable(dir)` resolving to `true` when files can be created under `dir` and `false` otherwise (any underlying error treated as not writable), without leaving any probe files behind.

#### Scenario: Writable directory

- **WHEN** `isDirWritable(dir)` is called on a writable directory
- **THEN** it resolves to `true` and no temporary probe file remains in `dir`

#### Scenario: Non-writable or missing directory

- **WHEN** `isDirWritable(dir)` is called on a read-only or non-existent directory
- **THEN** it resolves to `false`

### Requirement: Upward marker discovery

The system SHALL provide `findMarkerUpwards(startDir)` returning `ResultAsync` that resolves `startDir` to an absolute path and walks upward to the filesystem root, one folder at a time, returning `{ dir, marker }` for the nearest ancestor (including `startDir`) containing a valid marker, or `null` if none is found, stopping at the root without looping.

#### Scenario: Marker found in an ancestor

- **WHEN** a marker exists at `dir` and `findMarkerUpwards` is called from a nested subdirectory of `dir`
- **THEN** it returns `{ dir, marker }` for that ancestor

#### Scenario: No marker anywhere up to root

- **WHEN** no ancestor of `startDir` contains a marker
- **THEN** `findMarkerUpwards(startDir)` returns `null` and terminates at the filesystem root

### Requirement: Filesystem-only, no DB coupling, single id scheme

`src/modules/anchor/marker.ts` SHALL perform no database access and import nothing from `src/db/`. Any id it persists SHALL be the caller-supplied `randomUUIDv7()` value — the single uuidv7 scheme — never `crypto.randomUUID()` (v4) or ULID.

#### Scenario: Module is filesystem-only

- **WHEN** `src/modules/anchor/marker.ts` is inspected
- **THEN** it imports only from `node:*`/`Bun` with no DB query/mutation calls
- **AND** it generates no ids itself

