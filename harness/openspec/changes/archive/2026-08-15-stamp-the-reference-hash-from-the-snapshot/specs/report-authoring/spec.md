# Delta: report-authoring

## ADDED Requirements

### Requirement: The hash stamps from the pinned snapshot
The land path of an add and of a change MUST accept an artifact reference that carries the path alone. The land stamps the absent hash from the snapshot entry at that path, before the grammar parse. A path-only reference whose path is not in the snapshot MUST refuse as an unresolved reference, and the refusal names the path. The stamp fills an absent hash only. An explicit hash that differs from the snapshot MUST keep the `hash-mismatch` refusal, because that arm serves a draft that predates a re-pin.

#### Scenario: A path-only reference lands with the snapshot hash
- **WHEN** the agent adds a table block whose binding carries a path in the snapshot and no hash
- **THEN** the block lands, and the persisted reference carries the hash of the snapshot entry

#### Scenario: An unknown path refuses and names the path
- **WHEN** the agent adds a block whose binding carries a path that the snapshot does not hold, and no hash
- **THEN** the operation refuses as an unresolved reference, and the detail names the path

#### Scenario: A stale explicit hash still refuses as a mismatch
- **WHEN** the agent adds a block whose binding carries a hash that differs from the snapshot entry
- **THEN** the operation refuses with the `hash-mismatch` reason

#### Scenario: A derivation input stamps too
- **WHEN** the agent adds a metric whose derivation inputs carry paths in the snapshot and no hashes
- **THEN** the block lands, and each input carries the hash of its snapshot entry
