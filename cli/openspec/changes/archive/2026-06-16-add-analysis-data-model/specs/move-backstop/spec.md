## ADDED Requirements

### Requirement: Repair a marker's cached path

The system SHALL register `inf repair [<path>]` (`runRepair` in `src/modules/anchor/backstop.ts`) that reads the marker at `<path>` (default cwd), looks up its anchors row by id, updates the row's `cachedPath` to the canonical `<path>`, and reports the change. It SHALL report when the row already points there, and error clearly when `<path>` has no marker or the id has no anchors row.

#### Scenario: Repair self-heals the cached path

- **WHEN** `inf repair` runs in a marked directory whose anchors row has a stale `cachedPath`
- **THEN** the row's `cachedPath` is updated to the directory and the before/after is printed

#### Scenario: No marker errors

- **WHEN** `inf repair <path>` is run where `<path>` has no marker
- **THEN** it prints an error and exits non-zero

### Requirement: Relocate anchors by filesystem path

The system SHALL register `inf relocate [<fromPath> <toPath>]` re-pointing the single anchor tracked at `<fromPath>` to `<toPath>`, or `inf relocate --from <prefix> --to <prefix>` rewriting every anchor `cachedPath` and every raw absolute input path under the prefix. The backstop commands are addressed by **filesystem path, never by an analysis** — re-pointing a folder's identity is the anchor's job, and an anchor outlives any analysis homed in it. When the single-anchor target has no marker but the anchor expected one (`markerWritten: true`), it SHALL confirm before proceeding.

#### Scenario: Re-point a single anchor after a move

- **WHEN** `inf relocate /old/path /new/path` is run and an anchor is tracked at `/old/path`
- **THEN** that anchor's `cachedPath` becomes `/new/path` and the before/after is printed

#### Scenario: Warn when the target lacks an expected marker

- **WHEN** `<toPath>` has no marker for the anchor but the anchor had `markerWritten: true`
- **THEN** the command warns and only proceeds after confirmation

#### Scenario: Batch rewrite a moved prefix

- **WHEN** `inf relocate --from /old --to /new` is confirmed
- **THEN** all anchor cached paths and raw absolute input paths under `/old` are rewritten to `/new` and the changed counts are printed

#### Scenario: Empty prefix set is a no-op

- **WHEN** `--from` matches no anchors
- **THEN** the command reports nothing to relocate and makes no changes

### Requirement: Prune dead anchors

The system SHALL register `inf prune` (`runPrune`) that, for each anchor with `markerWritten: true` whose `cachedPath` no longer exists and which `resolveAnchor` cannot re-find, lists the affected analyses and, on confirmation, deletes the analyses (cascading their inputs via the FK) and the anchor. It SHALL NOT delete on a transient or re-findable miss.

#### Scenario: Prune offers to drop a gone folder's records

- **WHEN** an anchor's folder has been deleted and cannot be re-found
- **THEN** `inf prune` lists it with its analysis count and, on confirmation, deletes them

#### Scenario: Re-findable anchors are not pruned

- **WHEN** an anchor's folder moved but is still re-findable via reconciliation
- **THEN** `inf prune` does not list or delete it

### Requirement: Copied folders are surfaced; clone/fork resolution is deferred

A copied folder SHALL be detected (`classifyMarkerSighting` → `"copy"`, surfaced as a `copy` context) and SHALL NEVER be auto-resolved or auto-merged into the original. Full re-mint-and-clone vs fork resolution is deferred (marked `TODO(extend)`); until it lands, the default command directs the user to `inf repair` / `inf relocate`.

#### Scenario: Copy is detected and surfaced, never merged

- **WHEN** a copied folder is encountered
- **THEN** it is reported as a copy and the user is directed to the backstop, with the original anchor's records untouched

#### Scenario: Clone/fork resolution not yet built

- **WHEN** the copy-resolution path is reached
- **THEN** no clone or fork is performed automatically (the capability is deferred behind a `TODO(extend)` marker)
