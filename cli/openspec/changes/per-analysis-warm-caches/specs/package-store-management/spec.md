# package-store-management Delta — Per-Analysis Warm Caches

## MODIFIED Requirements

### Requirement: The store reports its farms and its disk use

`inflexa store ls` MUST count the warm caches under `farm-caches/` in its disk
report, beside the pool and the farms. A cache is real bytes — the entries
that the runs of its analysis compiled — thus a report that skips it
understates the store.

#### Scenario: The disk report covers the caches

- **GIVEN** a store with a pool, two farms, and two warm caches
- **WHEN** `inflexa store ls` runs
- **THEN** the disk figure covers the caches, beside the pool and the farms
