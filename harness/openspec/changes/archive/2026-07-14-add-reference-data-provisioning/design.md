## Context

The harness already owns the sandbox reference-store contract: embedders may mount a host directory or PVC read-only at `/mnt/refs`, and sandbox agents receive `list_available_refs`. The current tool is a static singleton that reads `/mnt/refs/registry.json` from the harness process. That works only when the harness process itself sees that path, treats a missing registry as a missing store, and hides user-added files not named by the registry.

The local CLI and managed deployment now both need to provision the same supported datasets. The common facts are dataset identity, version, provenance, licensing, the upstream that publishes each file, what integrity that upstream can actually guarantee, and the final sandbox layout. Credentials, storage roots, prompts, PVC lifecycle, and update policy remain host concerns.

## Goals / Non-Goals

**Goals:**

- Give supported reference data one versioned, reviewable owner shared by all embedders.
- Keep the catalog's provenance and licensing claims true by construction: the bytes come from the party the catalog names.
- State honestly, per artifact, what integrity can be guaranteed — rather than uniformly promising a verification we cannot deliver.
- Keep the harness host-agnostic by returning install plans rather than performing downloads.
- Make runtime discovery reflect the filesystem actually mounted in the sandbox.
- Discover arbitrary user content without requiring catalog or receipt registration.
- Bound inventory cost and model-context size while allowing agents to drill into a subtree.

**Non-Goals:**

- Mirroring, re-hosting, converting, or otherwise redistributing reference bytes.
- Downloading data from a sandbox workload or granting the sandbox network access.
- Owning local XDG paths, cloud buckets, PVC provisioning, credentials, prompts, or progress rendering.
- Parsing scientific data formats or inferring biological semantics from file contents.

## Decisions

### The harness owns a checked-in catalog; embedders own transfer only

The catalog lives under `src/reference-data/`, is validated as trusted package data, and is exposed through the curated package barrel. Each dataset entry carries a stable id, version, title, description, source and license links, recommendation/grouping metadata, and one or more final-file artifacts. A selection resolves to a pure install plan; the embedder stages, verifies, and activates it.

An alternative was a root-level JSON file: it has no package/build owner and would force the CLI binary, harness package, and managed tooling to invent separate packaging rules. An alternative was a CLI-local catalog; the second real consumer makes that ownership incorrect.

### Artifacts name their upstream publisher — there is no mirror and no configurable base

Each artifact carries the real `https` URL of the third party that publishes it (NCBI, Reactome, WikiPathways, Zenodo, GTEx, CellTypist). The project hosts and redistributes nothing.

**Rejected: an opaque distribution key plus an embedder-mapped base URL** (`INFLEXA_REFERENCE_DATA_BASE_URL`, an internal mirror for managed). It looked like a clean host-neutral seam, but it makes the source *substitutable* — and the catalog's most valuable content is precisely its claim about the source. Provenance ("this is NCBI's gene_info") and licensing ("you accept NCBI's terms") are only true of the upstream the catalog names; behind a configurable base they become claims about whatever bytes an operator decided to serve. A mirror also silently converts us into a redistributor of data whose licences we did not review for redistribution. So there is nothing to configure: no env var, no flag, no config key can redirect a fetch.

The cost is accepted deliberately: we depend on upstream availability and on upstream URL stability, and we cannot serve a faster or geographically closer copy. If an upstream URL moves, that is a catalog change and passes package review — which is the same review that any change to a provenance claim deserves.

### Integrity is a property of the upstream, not a preference

Each artifact declares an integrity class:

- **`pinned`** — the upstream publishes immutable, versioned bytes (a dated WikiPathways snapshot, a Zenodo record, GTEx v8, a versioned CellTypist model). The catalog carries `bytes` + `sha256`; a download that does not match them fails and nothing is activated.
- **`unpinned`** — the upstream regenerates the same URL in place. NCBI rebuilds `gene_info` continuously; Reactome overwrites `current` each quarter and **deletes** the prior release (verified: `/download/95` and `/download/96` are 404, so there is not even a stable archival URL to pin instead). No checked-in digest can survive that.

**Rejected: pin a digest to a mutable upstream anyway.** A digest that is guaranteed to go stale is strictly worse than no digest: it promises verification and delivers a broken download — every user of that dataset gets a hard "SHA-256 mismatch" failure the day the upstream rebuilds, with no local fault and no local fix. It converts a routine refresh into an outage, and it would train users to bypass verification.

For `unpinned` artifacts, integrity is therefore **trust-on-first-use**: the installer records the bytes and digest it actually received in the receipt, and later verification proves the files are unchanged *since install*. That is a real, checkable guarantee against local corruption and tampering — it is simply weaker than `pinned`, and it is surfaced to the user as such rather than being dressed up as content-addressing.

### Only files an upstream actually serves are catalogued

**Rejected: locally-derived artifacts** (the earlier design converted several sources to `.parquet` and catalogued the conversions). No third party serves those files, so they cannot be fetched from a publisher — only from us. Their SHA-256 attests to nothing but the machine that produced them, and shipping them makes us the distributor of a derived work under someone else's licence. Format convenience is a workload concern; the sandbox can convert on read.

The catalog therefore describes only final files as published, and contains no installer scripts, shell commands, or untyped transformation recipes. A future archive format requires an explicit catalog-version extension rather than an untyped recipe escape hatch.

### An artifact's identity is not its URL

Resumable transfer state is keyed off `<dataset-id>/<version>/<path>` (`referenceArtifactKey`), never off the URL. An upstream that moves a file must not orphan an in-flight partial or resurrect a stale one under a new name.

### Receipts record what was received, not what was expected

The receipt shape (`src/reference-data/receipt.ts`) records, per artifact, the relative path, integrity class, and the size + SHA-256 **observed at install**. Digests are never copied from the catalog: for `pinned` they necessarily agree (activation fails otherwise), and for `unpinned` the receipt is the *only* honest record of what the mutable upstream served — and therefore the thing `verify` must compare against. Receipts remain optional metadata; an absent or invalid one never hides readable files.

The legacy top-level `registry.json` remains an optional enrichment source, no longer the availability oracle, and can be retired once managed stores emit receipts.

### Discovery runs against the live sandbox filesystem

`list_available_refs` becomes a dependency-bearing tool created with the sandbox agent. It uses the same internal sandbox-exec runner as `execute_command`, receives a replay-stable function id and step deadline, and declares `executionMode: "workflow"`. The shared runner remains the one submit/await chokepoint.

The tool accepts an optional path constrained beneath `/mnt/refs`. The default call returns a bounded summary of the root; a path call drills into one subtree. It does not follow symlinks, excludes the reserved metadata directory from data results, reports truncation explicitly, and distinguishes unmounted, empty, and populated stores. The scan runs where `/mnt/refs` is actually mounted, so Docker host paths and Kubernetes PVC paths need not be visible under that name in the harness process.

An alternative was passing a host `refsRoot` into agent construction. That would report the embedder's intended source rather than the sandbox's observable truth and would couple Docker and Kubernetes path models to the tool.

### No library-specific reference path is baked into the sandbox image

The image previously carried `ENV CELLTYPIST_FOLDER=/mnt/refs/celltypist_models`, so that CellTypist's by-name model lookup would resolve without a network call. That is removed.

**Rejected: keep the baked env var.** It contradicts the ref-store rule that no reference-store environment variables are injected, and it cannot be correct: the store is optional (the path usually points at nothing), and its layout is owned by the catalog and versioned per dataset — so a path compiled into the image either dangles or pins the image to one catalog version. Impersonating a library's private cache layout in the reference store, purely so a by-name lookup succeeds, would freeze that layout as an image-level contract.

Agents instead call `list_available_refs`, receive absolute paths, and pass them explicitly — the contract Azimuth (`Azimuth::LoadReference()`) already required. A library that insists on an env var can have one exported per-command, by the agent that just learned the real path; the shared sandbox standards say so.

### Discovery is bounded and metadata is enrichment

A complete recursive manifest can be enormous for sharded references. The default result summarizes top-level entries with counts, aggregate bytes where cheaply available, representative file types, and concrete `/mnt/refs/...` paths. Drill-down remains capped by entry count and output bytes and returns a continuation/truncation hint rather than silently dropping data. Catalog descriptions, receipts, and legacy registry fields may add names and provenance to matching paths; the filesystem inventory is always merged in, so `user/` and any other unregistered content remains visible.

## Risks / Trade-offs

- **We depend on upstream availability and URL stability** → Accepted as the price of not being a redistributor. A moved URL is a catalog change under package review; a down upstream fails the install without touching a prior activation.
- **`unpinned` datasets can change under us between installs** → State it plainly rather than hide it: the class is visible in `refs list`, verification names which guarantee it checked, and a refresh is an explicit `--force` re-fetch.
- **Catalog changes require a harness release** → Intentional: dataset identity, source, and digests are supply-chain inputs and should pass package review.
- **A sandbox scan consumes an exec operation** → Keep it on-demand, bounded, and replay-safe through the existing runner; agents already orient once before analysis.
- **Legacy registry metadata may disagree with disk** → Disk wins; stale metadata is labeled or ignored and never causes a real path to disappear.
- **User content may contain misleading names or symlinks** → Treat it as untrusted read-only data, never execute it during discovery, never follow symlinks, and keep sandbox confinement unchanged.

## Migration Plan

1. Add and validate the catalog and receipt contracts without changing mounts.
2. Export the catalog selection interface for embedders.
3. Convert `list_available_refs` to sandbox-visible bounded discovery with receipt and registry enrichment.
4. Drop the image's baked reference env var and state the explicit-path contract in the shared sandbox standards.
5. Keep existing managed stores working unchanged; their registry becomes optional metadata.

Rollback is additive for catalog consumers. Reverting dynamic discovery restores manifest-only behavior but does not alter stored reference bytes.
