# move-backstop Specification

## Purpose
Explicit move/rename recovery addressed by filesystem path — `repair`, `relocate` (single pair and `--from/--to` prefix batch), and `prune` — plus the surfacing of copied folders (clone/fork resolution deferred).

## Requirements

### Requirement: Repair a marker's cached path

The system SHALL register `inflexa repair [<path>]` as a client of `POST /api/v1/anchors/repair`. The command SHALL resolve `<path>` (default cwd) against its own working folder and send the absolute path. The server SHALL read the marker at that path, look up its anchors row by id, update the row's `cachedPath` to the canonical path, and report the before and after paths. It SHALL report when the row already points there, and the command SHALL error clearly when the path has no marker or the id has no anchors row.

#### Scenario: Repair self-heals the cached path

- **WHEN** `inflexa repair` runs in a marked directory whose anchors row has a stale `cachedPath`
- **THEN** the row's `cachedPath` is updated to the directory and the before/after is printed

#### Scenario: No marker errors

- **WHEN** `inflexa repair <path>` is run where `<path>` has no marker
- **THEN** it prints an error and exits non-zero

### Requirement: Relocate anchors by filesystem path

The system SHALL register `inflexa relocate [<fromPath> <toPath>]` re-pointing the single anchor tracked at `<fromPath>` to `<toPath>`, or `inflexa relocate --from <prefix> --to <prefix>` rewriting every anchor `cachedPath` and every raw absolute input path under the prefix. The backstop commands are addressed by **filesystem path, never by an analysis** — re-pointing a folder's identity is the anchor's job, and an anchor outlives any analysis homed in it. When the single-anchor target has no marker but the anchor expected one (`markerWritten: true`), it SHALL confirm before proceeding.

#### Scenario: Re-point a single anchor after a move

- **WHEN** `inflexa relocate /old/path /new/path` is run and an anchor is tracked at `/old/path`
- **THEN** that anchor's `cachedPath` becomes `/new/path` and the before/after is printed

#### Scenario: Warn when the target lacks an expected marker

- **WHEN** `<toPath>` has no marker for the anchor but the anchor had `markerWritten: true`
- **THEN** the command warns and only proceeds after confirmation

#### Scenario: Batch rewrite a moved prefix

- **WHEN** `inflexa relocate --from /old --to /new` is confirmed
- **THEN** all anchor cached paths and raw absolute input paths under `/old` are rewritten to `/new` and the changed counts are printed

#### Scenario: Empty prefix set is a no-op

- **WHEN** `--from` matches no anchors
- **THEN** the command reports nothing to relocate and makes no changes

### Requirement: Prune dead anchors

The system SHALL register `inflexa prune` as a client of `POST /api/v1/anchors/prune`. The server SHALL select each anchor with `markerWritten: true` whose `cachedPath` no longer exists and which `resolveAnchor` cannot re-find. The command SHALL send the absolute folder of the client as `cwd`, and the search for a moved folder SHALL start there, never in the folder of the server. It SHALL NOT select an anchor on a transient or re-findable miss. The command SHALL first send a dry run, list each selected anchor with its analysis count, and ask for confirmation. On confirmation it SHALL send the ids of the listed anchors, so an anchor whose folder goes after the preview is not taken.

The server SHALL keep an anchor when the busy gate of the local server reports work for one of its analyses, and SHALL report that anchor as skipped with the analysis and the reasons. For each other anchor, it SHALL reclaim the Postgres footprint of each analysis through the pool of its booted runtime, then delete the analyses (cascading their inputs through the FK) and the anchor. The purge SHALL precede each SQLite delete, because the SQLite rows carry the only copy of the analysis ids. When the runtime is not ready and a selected anchor holds an analysis, the server SHALL refuse with 503 `unavailable` and prune nothing.

A failed purge SHALL stop the prune with each SQLite row still present, and the message SHALL say that nothing was lost. Because the purge is idempotent, a second `inflexa prune` after the cause is fixed SHALL complete the prune.

The server MUST run the busy gate of each analysis again directly before its purge. A turn, a run, or a profile can start on an analysis while the purges before it run. When the gate reports work, the server MUST stop the prune with 409 `busy`. The answer MUST name the analysis and the work, and the server MUST delete no SQLite row. A second `inflexa prune` then keeps the anchor of that analysis.

#### Scenario: Prune offers to drop a gone folder's records

- **WHEN** an anchor's folder has been deleted and cannot be re-found
- **THEN** `inflexa prune` lists it with its analysis count and, on confirmation, deletes them

#### Scenario: Re-findable anchors are not pruned

- **WHEN** an anchor's folder moved but is still re-findable via reconciliation
- **THEN** `inflexa prune` does not list or delete it

#### Scenario: Pruning reclaims each analysis's Postgres footprint first

- **GIVEN** a dead anchor with two analyses that have conversations and runs
- **WHEN** `inflexa prune` is confirmed
- **THEN** the purge runs for both analysis ids before either SQLite row is deleted

#### Scenario: An analysis with work keeps its anchor

- **GIVEN** a dead anchor whose analysis has a chat turn that runs in the server
- **WHEN** `inflexa prune` is confirmed
- **THEN** that anchor and its analyses stay, and the command names the analysis and the work that holds it

#### Scenario: A server with no runtime prunes no analysis

- **GIVEN** a server whose runtime is not ready, and a dead anchor that holds an analysis
- **WHEN** `inflexa prune` is confirmed
- **THEN** the server refuses with 503 `unavailable`, and no anchor and no analysis row is deleted

#### Scenario: A failed purge leaves the prune retryable

- **GIVEN** a confirmed prune whose purge fails on one analysis
- **WHEN** the failure is reported
- **THEN** every SQLite row remains, and a second `inflexa prune` after the cause is fixed completes

#### Scenario: Work that starts during the prune stops it before the purge of its analysis

- **GIVEN** a dead anchor with two analyses, and a chat turn that starts on the second analysis while the server purges the first one
- **WHEN** the prune reaches the second analysis
- **THEN** the server answers 409 `busy` with the analysis and the work, it does not purge the second analysis, and every SQLite row remains

### Requirement: Copied folders are surfaced; clone/fork resolution is deferred

A copied folder SHALL be detected (`classifyMarkerSighting` → `"copy"`, surfaced as a `copy` context) and SHALL NEVER be auto-resolved or auto-merged into the original. Full re-mint-and-clone vs fork resolution is deferred (marked `TODO(extend)`); until it lands, the default command directs the user to `inflexa repair` / `inflexa relocate`.

#### Scenario: Copy is detected and surfaced, never merged

- **WHEN** a copied folder is encountered
- **THEN** it is reported as a copy and the user is directed to the backstop, with the original anchor's records untouched

#### Scenario: Clone/fork resolution not yet built

- **WHEN** the copy-resolution path is reached
- **THEN** no clone or fork is performed automatically (the capability is deferred behind a `TODO(extend)` marker)
