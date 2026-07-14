## Context

The harness already owns the sandbox reference-store contract: embedders may mount a host directory or PVC read-only at `/mnt/refs`, and sandbox agents receive `list_available_refs`. The current tool is a static singleton that reads `/mnt/refs/registry.json` from the harness process. That works only when the harness process itself sees that path, treats a missing registry as a missing store, and hides user-added files not named by the registry.

The local CLI and managed deployment now both need to provision the same supported datasets. The common facts are dataset identity, version, provenance, licensing, content hashes, sizes, and final sandbox layout. Transfer URLs, credentials, storage roots, prompts, PVC lifecycle, and update policy remain host concerns.

## Goals / Non-Goals

**Goals:**

- Give supported reference data one versioned, reviewable owner shared by all embedders.
- Keep the harness host-agnostic by returning content-addressed install plans rather than performing downloads.
- Make runtime discovery reflect the filesystem actually mounted in the sandbox.
- Discover arbitrary user content without requiring catalog or receipt registration.
- Bound inventory cost and model-context size while allowing agents to drill into a subtree.
- Keep existing managed `registry.json` stores useful during migration.

**Non-Goals:**

- Downloading data from a sandbox workload or granting the sandbox network access.
- Owning local XDG paths, cloud buckets, PVC provisioning, credentials, prompts, or progress rendering.
- Defining a mutable remote catalog or allowing an embedder to silently replace catalog content.
- Parsing scientific data formats or inferring biological semantics from file contents.

## Decisions

### The harness owns a checked-in catalog; embedders own artifact resolution and transfer

The catalog lives under `src/reference-data/`, is validated as trusted package data, and is exposed through the curated package barrel. Each dataset entry carries a stable id, version, title, description, source and license links, recommendation/grouping metadata, and one or more final-file artifacts. Each artifact carries an opaque distribution key, byte size, SHA-256 digest, and a safe path relative to the dataset's installation root.

The catalog deliberately carries an artifact key rather than a deployment URL. The CLI maps the key to the public distribution endpoint; managed infrastructure may map the same key to an internal mirror. This keeps content identity and sandbox layout identical without making network topology part of the harness interface.

An alternative was a root-level JSON file. That has no package/build owner and would require the CLI binary, harness package, and managed tooling to invent separate packaging rules. An alternative was a CLI-local catalog; the second real consumer makes that ownership incorrect.

### Catalog artifacts are final files, not installer recipes

The first catalog version describes the final files of a dataset rather than arbitrary scripts or archive extraction instructions. Build/publish automation is responsible for producing those immutable files. A selection resolves to a pure install plan containing dataset roots and file artifacts; the embedder stages, verifies, and activates the plan.

This keeps the harness interface small and avoids embedding host-specific process execution, archive tooling, or untrusted transformation logic. A future archive format requires an explicit catalog-version extension rather than an untyped recipe escape hatch.

### Receipts are a shared optional metadata format

The harness defines a versioned receipt shape recording dataset id/version, installed artifacts, digests, sizes, relative paths, and activation time. Both embedders may write receipts under a reserved metadata directory. Discovery may use valid receipts to label catalog-managed datasets and preferred versions, but invalid or absent receipts never hide files.

The legacy top-level `registry.json` remains an optional enrichment source. It is no longer the availability oracle and can be retired independently after managed stores emit receipts.

### Discovery runs against the live sandbox filesystem

`list_available_refs` becomes a dependency-bearing tool created with the sandbox agent. It uses the same internal sandbox-exec runner as `execute_command`, receives a replay-stable function id and step deadline, and declares `executionMode: "workflow"`. The shared runner remains the one submit/await chokepoint; the reference tool does not introduce a parallel sandbox protocol.

The tool accepts an optional path constrained beneath `/mnt/refs`. The default call returns a bounded summary of the root; a path call drills into one subtree. It does not follow symlinks, excludes the reserved metadata directory from data results, reports truncation explicitly, and distinguishes unmounted, empty, and populated stores. The scan runs where `/mnt/refs` is actually mounted, so Docker host paths and Kubernetes PVC paths need not be visible under that name in the harness process.

An alternative was passing a host `refsRoot` into agent construction. That would report the embedder's intended source rather than the sandbox's observable truth and would couple Docker and Kubernetes path models to the tool.

### Discovery is bounded and metadata is enrichment

A complete recursive manifest can be enormous for sharded references. The default result summarizes top-level entries with counts, aggregate bytes where cheaply available, representative file types, and concrete `/mnt/refs/...` paths. Drill-down remains capped by entry count and output bytes and returns a continuation/truncation hint rather than silently dropping data.

Catalog descriptions, receipts, and legacy registry fields may add names and provenance to matching paths. The filesystem inventory is always merged in, so `user/` and any other unregistered content remains visible.

## Risks / Trade-offs

- **Catalog changes require a harness release** → This is intentional: dataset identity and digests are supply-chain inputs and should pass package review. Artifact bytes can be published independently under already-cataloged immutable keys.
- **A sandbox scan consumes an exec operation** → Keep it on-demand, bounded, and replay-safe through the existing runner; agents already orient once before analysis.
- **Large directories can still be expensive to summarize** → Bound traversal work as well as rendered output, avoid content hashing during discovery, and require drill-down for deep trees.
- **Legacy registry metadata may disagree with disk** → Disk wins; stale metadata is labeled or ignored and never causes a real path to disappear.
- **User content may contain misleading names or symlinks** → Treat it as untrusted read-only data, never execute it during discovery, never follow symlinks, and keep sandbox confinement unchanged.

## Migration Plan

1. Add and validate the catalog and receipt contracts without changing mounts.
2. Export the catalog selection interface for embedders.
3. Convert `list_available_refs` to sandbox-visible bounded discovery with receipt and registry enrichment.
4. Keep existing managed stores working unchanged; their registry becomes optional metadata.
5. Let each embedder adopt the catalog and receipt format independently.

Rollback is additive for catalog consumers. Reverting dynamic discovery restores manifest-only behavior but does not alter stored reference bytes.

## Open Questions

- The initial catalog contents and public artifact publication base are release-data work; the contract does not require those deployment values to be decided in this change.
