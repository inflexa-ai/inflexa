## REMOVED Requirements

### Requirement: Count and bulk helpers for grouping and recovery

**Reason**: No caller reads `countAnalysesByProject` or `countAnalysesByAnchor`. The paged project read gives the count of each project in its own statement. The prune lists the analyses of the dead anchors in one read.
**Migration**: The requirement "Bulk helpers for recovery" keeps `deleteAnalysesForAnchor` and `relocateRawInputPrefix`.

## ADDED Requirements

### Requirement: Bulk helpers for recovery

The system MUST give `deleteAnalysesForAnchor(anchorId)`, which `prune` uses. It MUST return the count of the deleted rows, and the input refs cascade. The system MUST also give `relocateRawInputPrefix(fromPrefix, toPrefix)`. It MUST rewrite each input path with `anchor_id IS NULL` under a moved tree, on true path boundaries, and return the count that it rewrote.

The system MUST NOT keep a count query for each project or for each anchor. The paged project read gives the count of each project in its own statement. The prune lists the analyses of the dead anchors in one read.

#### Scenario: Raw input prefix rewrite respects path boundaries

- **WHEN** `relocateRawInputPrefix("/a/b", "/a/c")` runs
- **THEN** a raw input at `/a/b/x` becomes `/a/c/x` and a sibling `/a/bc` stays as it is

#### Scenario: A prune deletes the analyses of a dead anchor

- **GIVEN** a dead anchor that homes two analyses
- **WHEN** `deleteAnalysesForAnchor(anchorId)` runs
- **THEN** it returns 2, and the input rows of the two analyses go with them
