## MODIFIED Requirements

### Requirement: References are discoverable via the list_available_refs tool

The harness SHALL expose a dependency-bearing `list_available_refs` tool that inspects the reference store on the HOST filesystem and reports it at `/mnt/refs`, the container path a sandbox mounts it at — read where it lives, render where the caller will open it. Reading host-side is what lets the conversation agent and the planner ask what reference data exists before any sandbox is created, and a step agent asking mid-run observes the same store, because the mount and the read path are the same bytes.

The read root SHALL be the embedder-supplied `refStorePath` when one is given, and `/mnt/refs` otherwise. The fallback SHALL be the same container mountpoint the sandbox backends mount the store at, so a host whose own process sees the store the way a sandbox does — a Kubernetes pod holding the ref-store PVC — configures nothing. The fallback SHALL NOT change what is reported: the scan stats its root before reporting anything, so a host with nothing mounted there SHALL report the store as unavailable exactly as an omitted path always has. An embedder SHALL supply `refStorePath` only to name a location the container mountpoint does not describe, as a native process bind-mounting a host directory into Docker does.

The tool SHALL accept an optional path constrained beneath the render root: an omitted path SHALL return a bounded root summary and a supplied path SHALL drill into that subtree. Results SHALL use absolute `/mnt/refs/...` paths, SHALL NOT follow symlinks, SHALL exclude reserved installer metadata from the data inventory, and SHALL report truncation explicitly when traversal or output limits are reached.

The tool SHALL distinguish an unavailable store, a present but empty store, and a populated store without throwing for any of those expected states.

#### Scenario: Arbitrary mounted files are available without a manifest

- **WHEN** `/mnt/refs/user/cohort/reference.h5ad` exists and no `registry.json` or receipt names it
- **THEN** `list_available_refs` reports that path through the root summary or a bounded drill-down result

#### Scenario: Store is present but empty

- **WHEN** the read root exists and contains no reference data
- **THEN** the tool returns an available-but-empty result rather than a missing-store result

#### Scenario: Store is not present

- **WHEN** the read root does not exist or is not a directory
- **THEN** the tool returns an unavailable data variant with an actionable note, without throwing

#### Scenario: An unconfigured embedder reads the container mountpoint

- **GIVEN** an embedder that supplies no `refStorePath`
- **WHEN** the tool scans
- **THEN** it reads `/mnt/refs` and returns exactly what an embedder supplying `/mnt/refs` explicitly would return

#### Scenario: Deep inventory is bounded

- **WHEN** a requested subtree exceeds the traversal or output limit
- **THEN** the tool returns the bounded entries plus an explicit truncation or drill-down hint

#### Scenario: Traversal outside the store is rejected

- **WHEN** the optional path is absolute outside `/mnt/refs` or contains traversal escaping the root
- **THEN** the tool returns an out-of-scope data result and performs no scan outside the store
