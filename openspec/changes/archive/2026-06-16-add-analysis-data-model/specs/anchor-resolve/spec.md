## ADDED Requirements

### Requirement: On-demand anchor creation

The system SHALL provide `getOrCreateAnchorForCwd(dir)` returning `Result<Anchor, DbError>` in `src/modules/anchor/anchor.ts`, the single anchor entry point used at analysis creation. For a folder that already has a marker it SHALL return the existing anchors row (self-healing a drifted `cachedPath`); for an unmarked writable folder it SHALL mint an id (`randomUUIDv7()`, inline), write the marker, and insert a row with `markerWritten: true`; for an unmarked non-writable folder it SHALL mint an id and insert a row with `markerWritten: false` without writing any marker. The minted id SHALL be a `randomUUIDv7()`, never `crypto.randomUUID()` or ULID.

#### Scenario: Create anchor for an unmarked writable directory

- **WHEN** `getOrCreateAnchorForCwd(dir)` is called on a writable directory with no marker
- **THEN** a `.inf/id` marker is written into `dir`
- **AND** an anchors row is inserted with `markerWritten: true` and `cachedPath` equal to the canonical `dir`

#### Scenario: Return existing anchor for a marked directory

- **WHEN** `getOrCreateAnchorForCwd(dir)` is called on a directory that already has a marker and a matching anchors row
- **THEN** it returns that existing anchor without minting a new id

#### Scenario: Self-heal a drifted cached path on the create path

- **WHEN** the directory's marker id has an anchors row whose `cachedPath` differs from `dir`
- **THEN** the row's `cachedPath` is updated to `dir` and the returned anchor reflects it

#### Scenario: Non-writable directory degrades to path-only

- **WHEN** `getOrCreateAnchorForCwd(dir)` is called on a non-writable directory with no marker
- **THEN** no marker is written and the inserted anchors row has `markerWritten: false`

### Requirement: Lazy anchor reconciliation

The system SHALL provide `resolveAnchor(anchorId, opts?)` returning `Result<{ anchor: Anchor; path: string | null }, DbError>` that reconciles the id to its live path via a three-step lazy algorithm, in order: (1) if the marker at the row's `cachedPath` matches the id, touch the anchor (`last_seen`) and return `cachedPath`; (2) if a search root (default cwd) or an ancestor holds a marker with the id, self-heal `cachedPath` to that directory and return it without scanning; (3) otherwise perform a bounded search over the search roots and known anchor cached paths, returning a unique hit (self-healed) or `path: null` for zero or multiple hits.

#### Scenario: Cached path still valid

- **WHEN** the marker at the anchor's `cachedPath` matches the id
- **THEN** `resolveAnchor` returns `path` equal to `cachedPath` and the anchor's `lastSeen` is updated

#### Scenario: Folder moved, resolving from inside it

- **WHEN** the folder was moved and `resolveAnchor` runs with a search root inside the new location
- **THEN** the anchor's `cachedPath` is self-healed to the new directory and the returned `path` is the new directory

#### Scenario: Ambiguous or dead reference

- **WHEN** no live marker for the id is found, or multiple are found
- **THEN** `resolveAnchor` returns `path: null` rather than guessing a location

### Requirement: Passive, no-litter anchor recovery

The system SHALL provide `recoverAnchors(searchRoots = [cwd])` returning `Result<{ recovered, unresolved }, DbError>` that runs reconciliation across anchors to heal moved folders. Recovery SHALL be self-healing only — it NEVER mints an anchor or writes a marker — so it is safe to call on a passive flow (e.g. opening the chat TUI) without violating the no-litter policy.

#### Scenario: Launch-time recovery heals without creating

- **WHEN** `recoverAnchors([workingDir])` runs at chat launch
- **THEN** anchors whose folders moved are re-pointed and the counts of `recovered`/`unresolved` are returned
- **AND** no new marker or anchors row is created by the recovery pass

### Requirement: Copy versus move classification

The system SHALL provide `classifyMarkerSighting(dir, marker)` returning `Result<"copy" | "move" | "ok", DbError>`: `"ok"` when the id's anchors `cachedPath` equals `dir` (or no row exists), `"copy"` when that `cachedPath` differs from `dir` and still exists on disk, and `"move"` when that `cachedPath` differs and no longer exists. It SHALL never auto-merge a copy.

#### Scenario: Same location is ok

- **WHEN** the marker id's row `cachedPath` equals `dir`
- **THEN** `classifyMarkerSighting` returns `"ok"`

#### Scenario: Copied folder detected

- **WHEN** the marker id's row `cachedPath` still exists and differs from `dir`
- **THEN** `classifyMarkerSighting` returns `"copy"` and performs no merge

#### Scenario: Moved folder detected

- **WHEN** the marker id's row `cachedPath` no longer exists and differs from `dir`
- **THEN** `classifyMarkerSighting` returns `"move"`

### Requirement: Library purity and error threading

The module SHALL perform no interactive I/O (no printing or prompting) and SHALL return all outcomes as data or `Result<…, DbError>`. Errors thrown by marker corruption SHALL be surfaced through the `Result` error channel rather than propagating as uncaught exceptions.

#### Scenario: No interactive prompts in the module

- **WHEN** an ambiguous reconciliation occurs
- **THEN** the function returns `path: null` (the caller decides UX); it does not prompt

#### Scenario: Corruption surfaced as a Result error

- **WHEN** a marker read needed by `getOrCreateAnchorForCwd` throws due to corruption
- **THEN** the function returns an `err` (DbError) carrying the cause, not an uncaught throw
