## Why

The harness already defines the read-only `/mnt/refs` mount, but its inventory is gated on a managed-only `registry.json` and the downloadable reference set has no host-neutral owner. Both the local CLI and managed deployment now need one versioned, reviewable catalog while sandboxes must still discover user-supplied files that are absent from that catalog.

## What Changes

- Add a harness-owned reference-data catalog describing supported datasets, their versions, provenance and licensing links, content identities, sizes, and sandbox-relative final-file locations.
- Export a small host-neutral catalog interface that validates entries and resolves a selection into an install plan; embedders remain responsible for artifact URL resolution, transfer, storage, credentials, and user interaction.
- Replace manifest-exclusive `list_available_refs` behavior with bounded, on-demand discovery of the filesystem actually visible inside the sandbox.
- Treat catalog or receipt metadata as optional enrichment only: arbitrary user-added reference files remain discoverable without registration.
- Preserve the existing read-only `/mnt/refs` mount and the prohibition on network downloads from sandbox workloads.

## Capabilities

### New Capabilities

- `reference-data-catalog`: The canonical, host-neutral catalog contract and selection/install-plan interface shared by local and managed embedders.

### Modified Capabilities

- `ref-store`: Reference discovery becomes filesystem-driven and sandbox-visible rather than requiring `/mnt/refs/registry.json`; metadata may enrich but never define the complete inventory.

## Impact

- Affects `harness/src/reference-data/`, the public package barrel, sandbox-agent tool construction, and `list_available_refs` tests and prompts.
- Changes the producer/consumer contract with both embedders: the harness defines content identity and install layout, while each embedder supplies artifact locations and provisioning behavior.
- The existing managed `registry.json` remains readable as optional metadata but is no longer required for availability.
