## Why

The harness already defines the read-only `/mnt/refs` mount, but its inventory is gated on a managed-only `registry.json` and the downloadable reference set has no host-neutral owner. Both the local CLI and managed deployment now need one versioned, reviewable catalog while sandboxes must still discover user-supplied files that are absent from that catalog.

The catalog is also a provenance claim, not just a download list. It only stays true if the bytes come from the party it names — so the catalog carries the real upstream URL rather than an opaque key an embedder resolves against a mirror it controls.

## What Changes

- Add a harness-owned reference-data catalog describing supported datasets, their versions, provenance and licensing links, sandbox-relative final-file locations, and the `https` URL of the third party that publishes each artifact.
- Fetch every artifact from its publisher: no mirror, no re-hosting, no distribution endpoint, and no embedder-configurable base URL that could substitute the source behind the catalog's own licensing/provenance claims.
- Give each artifact an integrity class reflecting what its upstream can guarantee: `pinned` (immutable versioned bytes — the catalog carries size + SHA-256) or `unpinned` (upstream regenerates the same URL in place — no checked-in digest can survive, so integrity is trust-on-first-use against the receipt).
- Export a small host-neutral catalog interface that validates entries and resolves a selection into an install plan; embedders remain responsible for transfer, storage, credentials, and user interaction — but never for choosing a different source.
- Define receipts that record the size, digest, and integrity class **observed at install**, so an `unpinned` dataset is still verifiable as "unchanged since install".
- Replace manifest-exclusive `list_available_refs` behavior with bounded, on-demand discovery of the filesystem actually visible inside the sandbox.
- Treat catalog or receipt metadata as optional enrichment only: arbitrary user-added reference files remain discoverable without registration.
- Preserve the existing read-only `/mnt/refs` mount and the prohibition on network downloads from sandbox workloads.

## Capabilities

### New Capabilities

- `reference-data-catalog`: The canonical, host-neutral catalog contract — upstream-sourced artifacts, integrity classes, install plans, and observed-bytes receipts — shared by local and managed embedders.

### Modified Capabilities

- `ref-store`: Reference discovery becomes filesystem-driven and sandbox-visible rather than requiring `/mnt/refs/registry.json`; metadata may enrich but never define the complete inventory.

## Impact

- Affects `harness/src/reference-data/`, the public package barrel, sandbox-agent tool construction, and `list_available_refs` tests and prompts.
- Changes the producer/consumer contract with both embedders: the harness defines dataset identity, upstream source, integrity guarantee, and install layout; each embedder supplies only provisioning behavior.
- Removes the sandbox image's baked `CELLTYPIST_FOLDER` reference path, which contradicted the existing ref-store rule that no reference-store environment variables are injected. Agents get absolute paths from `list_available_refs` and pass (or export) them explicitly.
- The existing managed `registry.json` remains readable as optional metadata but is no longer required for availability.
