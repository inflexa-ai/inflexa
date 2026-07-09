# data-profile-init — Delta

## ADDED Requirements

### Requirement: The staged-input manifest carries a per-file drift signature

Every `StagedInput` the embedder hands the data-profile trigger SHALL carry `mtimeMs: number` — the
source file's last-modification time in epoch milliseconds — alongside the existing `size`. Together
`(fileId, size, mtimeMs)` form the file's **drift signature**: the value a consumer compares against a
completed profile's `inputFiles` to decide whether the same bytes were profiled.

`mtimeMs` SHALL be a value the embedder already holds when it produces the manifest: the CLI reads it
from the `stat` it performs to record `size`; a managed service supplies the object store's
last-modified epoch. The harness treats it, like `fileId`/`key`/`mountName`, as an opaque label — it
never interprets, compares, or validates it, and it never reads the source filesystem.

#### Scenario: The manifest element carries size and mtime

- **WHEN** an embedder constructs a `StagedInput` for a source file
- **THEN** the element SHALL carry the file's `size` in bytes and its `mtimeMs` in epoch milliseconds

#### Scenario: The harness does not interpret the signature

- **WHEN** the data-profile workflow consumes a `StagedInput`
- **THEN** it SHALL persist `mtimeMs` into the completed result's `inputFiles` verbatim
- **AND** it SHALL NOT stat the source file, compare mtimes, or reject a manifest on the basis of them
