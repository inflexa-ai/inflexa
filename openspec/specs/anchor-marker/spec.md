# anchor-marker Specification

## Purpose
The on-disk `.inf/id` folder-identity marker: its path helper, canonicalization, validated and write-once read/write, directory-writability check, and upward discovery — a filesystem-only module that mints no ids and has no DB coupling.
## Requirements
### Requirement: Marker path helper

The system SHALL provide `markerPath(dir)` returning `join(dir, ".inf", "id")`, in the filesystem-only module `src/modules/anchor/marker.ts`.

#### Scenario: Marker path composition

- **WHEN** `markerPath("/data/genomics")` is called
- **THEN** it returns `/data/genomics/.inf/id`

### Requirement: Canonical path helper

The system SHALL provide `canonicalPath(p)` returning the canonical absolute form of `p` (resolving symlinks where the path exists, normalizing otherwise) so anchor paths compare and store consistently.

#### Scenario: Canonicalization is stable

- **WHEN** `canonicalPath` is called twice on paths that denote the same location
- **THEN** both calls return the same canonical string

### Requirement: Validated marker read

The system SHALL provide `readMarker(dir)` returning the parsed `AnchorMarker` when `<dir>/.inf/id` exists and is valid, `null` when the file is absent, and throwing when the file exists but is malformed JSON or has a `schemaVersion` other than `1`.

#### Scenario: Absent marker

- **WHEN** `<dir>/.inf/id` does not exist
- **THEN** `readMarker(dir)` returns `null`

#### Scenario: Valid marker

- **WHEN** `<dir>/.inf/id` contains `{ "schemaVersion": 1, "anchorId": "<uuidv7>" }`
- **THEN** `readMarker(dir)` returns that `AnchorMarker`

#### Scenario: Corrupt marker surfaces as an error

- **WHEN** `<dir>/.inf/id` contains malformed JSON or a `schemaVersion` other than `1`
- **THEN** `readMarker(dir)` throws rather than returning `null` or silently minting a new identity

### Requirement: Write-once marker write

The system SHALL provide `writeMarker(dir, anchorId)` that writes `<dir>/.inf/id` only when no valid marker exists, creating `<dir>/.inf/` as needed, and returns the `AnchorMarker` now on disk. The caller supplies the `anchorId` (minted inline with `randomUUIDv7()`); the marker module mints no ids. When a valid marker already exists, it SHALL be returned unchanged without rewriting; when an existing marker is corrupt, it SHALL throw rather than overwrite.

#### Scenario: First write creates the marker

- **WHEN** `writeMarker(dir, id)` is called and no marker exists
- **THEN** `<dir>/.inf/id` is created with `{ schemaVersion: 1, anchorId: id }`
- **AND** the returned marker carries `id`

#### Scenario: Second write is a no-op returning the existing id

- **WHEN** `writeMarker(dir, otherId)` is called and a valid marker with `id` already exists
- **THEN** the on-disk marker still carries the original `id`
- **AND** the returned marker carries the original `id`, not `otherId`

#### Scenario: Write refuses to clobber a corrupt marker

- **WHEN** `writeMarker(dir, id)` is called and the existing marker is corrupt
- **THEN** it throws and does not overwrite the file

### Requirement: Directory writability check

The system SHALL provide `isDirWritable(dir)` returning `true` when files can be created under `dir` and `false` otherwise (any underlying error treated as not writable), without leaving any probe files behind.

#### Scenario: Writable directory

- **WHEN** `isDirWritable(dir)` is called on a writable directory
- **THEN** it returns `true` and no temporary probe file remains in `dir`

#### Scenario: Non-writable or missing directory

- **WHEN** `isDirWritable(dir)` is called on a read-only or non-existent directory
- **THEN** it returns `false`

### Requirement: Upward marker discovery

The system SHALL provide `findMarkerUpwards(startDir)` that resolves `startDir` to an absolute path and walks upward to the filesystem root, returning `{ dir, marker }` for the nearest ancestor (including `startDir`) containing a valid marker, or `null` if none is found, stopping at the root without looping.

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

