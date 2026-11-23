# anchor-resolve Specification

## Purpose
On-demand anchor creation and lazy UUID→path reconciliation that self-heals moved or renamed folders, plus copy-vs-move classification and passive, no-litter recovery used at launch.
## Requirements
### Requirement: On-demand anchor creation

The system SHALL provide `getOrCreateAnchorForCwd(dir)` returning `ResultAsync<Anchor, AnchorEnsureError>` (the `DbError` union widened by `folder_is_copy`) in `src/modules/anchor/anchor.ts`, the single anchor entry point used at analysis creation. For a folder that already has a marker it SHALL return the existing anchors row (self-healing a drifted `cachedPath`). When the drifted `cachedPath` still holds the same marker, the folder is a copy: the function MUST return the err `folder_is_copy` with the folder and the original, and it MUST NOT change the row; for an unmarked writable folder it SHALL mint an id (`randomUUIDv7()`, inline), write the marker, and insert a row with `markerWritten: true`; for an unmarked non-writable folder it SHALL mint an id and insert a row with `markerWritten: false` without writing any marker. The minted id SHALL be a `randomUUIDv7()`, never `crypto.randomUUID()` or ULID.

#### Scenario: Create anchor for an unmarked writable directory

- **WHEN** `getOrCreateAnchorForCwd(dir)` is called on a writable directory with no marker
- **THEN** a `.inflexa/id` marker is written into `dir`
- **AND** an anchors row is inserted with `markerWritten: true` and `cachedPath` equal to the canonical `dir`

#### Scenario: Return existing anchor for a marked directory

- **WHEN** `getOrCreateAnchorForCwd(dir)` is called on a directory that already has a marker and a matching anchors row
- **THEN** it returns that existing anchor without minting a new id

#### Scenario: Self-heal a drifted cached path on the create path

- **WHEN** the directory's marker id has an anchors row whose `cachedPath` differs from `dir`
- **THEN** the row's `cachedPath` is updated to `dir` and the returned anchor reflects it

#### Scenario: A copy keeps the identity at the original

- **GIVEN** a folder that a user duplicated, thus the copy and the original hold the same marker, and the row points at the original
- **WHEN** `getOrCreateAnchorForCwd(copy)` is called
- **THEN** it returns the err `folder_is_copy`, and the `cachedPath` of the row stays at the original

#### Scenario: Non-writable directory degrades to path-only

- **WHEN** `getOrCreateAnchorForCwd(dir)` is called on a non-writable directory with no marker
- **THEN** no marker is written and the inserted anchors row has `markerWritten: false`

### Requirement: Lazy anchor reconciliation

The system SHALL provide `resolveAnchor(anchorId, opts?)` returning `ResultAsync<{ anchor: Anchor; path: string | null }, DbError>` that reconciles the id to its live path via a three-step lazy algorithm, in order: (1) if the marker at the row's `cachedPath` matches the id, touch the anchor (`last_seen`) and return `cachedPath`; (2) if a search root (default cwd) or an ancestor holds a marker with the id, self-heal `cachedPath` to that directory and return it without scanning; (3) otherwise perform a bounded search over the search roots and known anchor cached paths, returning a unique hit (self-healed) or `path: null` for zero or multiple hits. The marker reads SHALL run off the event loop. The bounded search SHALL read each candidate, with a fixed count of reads in flight, so a candidate on a hung mount holds one slot and the reads of a large anchor set do not fill the thread pool of the server.

Each marker read of a resolve MUST have a time limit. A read that does not answer in the limit MUST count as no match, thus a folder on a hung share cannot stop a resolve. A bounded search that finds no unique folder MUST be remembered for the life of the server. A later search of the same anchor over the same set of candidate folders MUST NOT read the folders again, and it gives `path: null`. Steps 1 and 2 still run, and a hit in them clears the misses of the anchor.

#### Scenario: Cached path still valid

- **WHEN** the marker at the anchor's `cachedPath` matches the id
- **THEN** `resolveAnchor` returns `path` equal to `cachedPath` and the anchor's `lastSeen` is updated

#### Scenario: Folder moved, resolving from inside it

- **WHEN** the folder was moved and `resolveAnchor` runs with a search root inside the new location
- **THEN** the anchor's `cachedPath` is self-healed to the new directory and the returned `path` is the new directory

#### Scenario: A hung folder does not stop the resolve

- **GIVEN** an anchor whose `cachedPath` is on a share that does not answer
- **WHEN** `resolveAnchor` runs
- **THEN** each read of that folder counts as no match after the time limit, and the resolve gives `path: null`

#### Scenario: A remembered miss

- **GIVEN** a bounded search for an anchor that found no folder
- **WHEN** the same anchor resolves again from the same search roots, with the same known anchors
- **THEN** the resolve reads no candidate folder of the search, and it gives `path: null`

#### Scenario: Ambiguous or dead reference

- **WHEN** no live marker for the id is found, or multiple are found
- **THEN** `resolveAnchor` returns `path: null` rather than guessing a location

### Requirement: Passive, no-litter anchor recovery

The system SHALL provide `recoverAnchors(searchRoots = [cwd])` returning `ResultAsync<{ recovered, unresolved }, DbError>` that runs reconciliation across anchors to heal moved folders. Recovery SHALL be self-healing only — it NEVER mints an anchor or writes a marker — so it is safe to call on a passive flow (e.g. opening the chat TUI) without violating the no-litter policy.

A launch MUST NOT wait for this recovery. The resolve of the launch already reconciles the anchor of the marker above the working folder. The server MUST start the recovery of each other anchor after it answers the resolve, and at most one such recovery MUST run at a time.

#### Scenario: A hung folder does not hold the launch

- **GIVEN** a known anchor whose folder is on a share that does not answer
- **WHEN** a chat launch resolves its working folder with the recovery
- **THEN** the server answers the resolve, and the recovery runs after the answer

#### Scenario: Launch-time recovery heals without creating

- **WHEN** `recoverAnchors([workingDir])` runs after a chat launch
- **THEN** anchors whose folders moved are re-pointed and the counts of `recovered`/`unresolved` are returned
- **AND** no new marker or anchors row is created by the recovery pass

### Requirement: Copy versus move classification

The system SHALL provide `classifyMarkerSighting(dir, marker)` returning `ResultAsync<MarkerSighting, DbError>`: `ok` when the id's anchors `cachedPath` equals `dir` (or no row exists), `copy` with the `original` folder when that `cachedPath` differs from `dir` and still holds the same marker, and `move` when that `cachedPath` differs and does not hold the same marker. A folder at the `cachedPath` with no marker, or with a different marker, is a `move`, because a moved project can leave a new folder at its old path. It SHALL never auto-merge a copy.

The system SHALL provide `giveCopyNewIdentity(path)`, which gives a copy its own identity. The function MUST make sure that the folder is a copy. Then it MUST write a new marker with a `randomUUIDv7()` id over the marker of the copy, and insert an anchors row at the folder. The original MUST keep its marker, its row, and its analyses. A folder that is not a copy MUST give the err `not_a_copy`, and the function MUST change nothing.

#### Scenario: Same location is ok

- **WHEN** the marker id's row `cachedPath` equals `dir`
- **THEN** `classifyMarkerSighting` returns `"ok"`

#### Scenario: Copied folder detected

- **WHEN** the marker id's row `cachedPath` differs from `dir` and still holds the same marker
- **THEN** `classifyMarkerSighting` returns `copy` with that `cachedPath` as the original, and performs no merge

#### Scenario: Moved folder detected

- **WHEN** the marker id's row `cachedPath` differs from `dir` and does not hold the same marker, or no longer exists
- **THEN** `classifyMarkerSighting` returns `move`

#### Scenario: A copy gets a new identity

- **GIVEN** a copy that holds the marker of its original
- **WHEN** `giveCopyNewIdentity(copy)` runs
- **THEN** the copy holds a new marker id with an anchors row at the copy, and the original keeps its marker and its row

### Requirement: Library purity and error threading

The module SHALL perform no interactive I/O (no printing or prompting) and SHALL return all outcomes as data or `Result<…, DbError>`. Errors thrown by marker corruption SHALL be surfaced through the `Result` error channel rather than propagating as uncaught exceptions.

#### Scenario: No interactive prompts in the module

- **WHEN** an ambiguous reconciliation occurs
- **THEN** the function returns `path: null` (the caller decides UX); it does not prompt

#### Scenario: Corruption surfaced as a Result error

- **WHEN** a marker read needed by `getOrCreateAnchorForCwd` throws due to corruption
- **THEN** the function returns an `err` (DbError) carrying the cause, not an uncaught throw

