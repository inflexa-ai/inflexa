## MODIFIED Requirements

### Requirement: References are discoverable via the list_available_refs tool

The harness SHALL expose a dependency-bearing `list_available_refs` tool that inspects the reference filesystem visible inside the active sandbox at `/mnt/refs`. The tool SHALL accept an optional path constrained beneath that root: an omitted path SHALL return a bounded root summary and a supplied path SHALL drill into that subtree. Results SHALL use absolute `/mnt/refs/...` paths, SHALL NOT follow symlinks, SHALL exclude reserved installer metadata from the data inventory, and SHALL report truncation explicitly when traversal or output limits are reached.

The tool SHALL distinguish an unmounted store, a mounted but empty store, and a populated store without throwing for any of those expected states. It SHALL execute through the shared sandbox-exec runner with replay-stable identity and workflow execution mode so discovery observes the same mount as analysis commands.

#### Scenario: Arbitrary mounted files are available without a manifest

- **WHEN** `/mnt/refs/user/cohort/reference.h5ad` exists and no `registry.json` or receipt names it
- **THEN** `list_available_refs` reports that path through the root summary or a bounded drill-down result

#### Scenario: Store is mounted but empty

- **WHEN** `/mnt/refs` is mounted and contains no reference data
- **THEN** the tool returns an available-but-empty result rather than a missing-store result

#### Scenario: Store is not mounted

- **WHEN** the active sandbox has no `/mnt/refs` mount
- **THEN** the tool returns an unavailable data variant with an actionable note, without throwing

#### Scenario: Deep inventory is bounded

- **WHEN** a requested subtree exceeds the traversal or output limit
- **THEN** the tool returns the bounded entries plus an explicit truncation or drill-down hint

#### Scenario: Traversal outside the store is rejected

- **WHEN** the optional path is absolute outside `/mnt/refs` or contains traversal escaping the root
- **THEN** the tool returns an out-of-scope data result and performs no scan outside the store

## REMOVED Requirements

### Requirement: The registry.json manifest defines the discoverable inventory

**Reason**: A manifest-exclusive inventory hides user-added files and cannot represent the live sandbox mount as the source of truth.

**Migration**: Existing `/mnt/refs/registry.json` files remain optional enrichment inputs. Managed stores may continue producing them while adopting the shared receipt format; readable files are discovered whether or not either metadata format exists.

## ADDED Requirements

### Requirement: Catalog and store metadata only enrich filesystem discovery

When a valid harness receipt or legacy `registry.json` describes a path that exists on disk, `list_available_refs` SHALL use its dataset name, version, provenance, category, or descriptive fields to enrich the rendered inventory. Metadata SHALL NOT add nonexistent files, hide unregistered files, or override the observed path and size of a filesystem entry.

#### Scenario: Managed and user content are merged

- **WHEN** a store contains a receipted managed dataset and unregistered content under `user/`
- **THEN** discovery reports both, enriching the managed entry and listing the user content from the filesystem

#### Scenario: Stale metadata is ignored

- **WHEN** metadata names a file that no longer exists
- **THEN** discovery omits the nonexistent file and continues reporting the remaining filesystem content
