## 1. Catalog and Receipt Contracts

- [x] 1.1 Add the reference-data catalog schema under `src/reference-data/`: safe ids/versions, safe relative destinations, `https`-only upstream artifact URLs, and the catalog-version contract.
- [x] 1.2 Model the artifact integrity class as a discriminated union — `pinned` (upstream-immutable: carries `bytes` + `sha256`) and `unpinned` (upstream regenerates the URL in place: carries neither) — and document why a digest is deliberately absent rather than stale.
- [x] 1.3 Populate the canonical catalog with real upstream URLs, provenance, and licences: `pinned` wikipathways-human, collectri-human, gtex-v8, celltypist-immune; `unpinned` (version `current`) ncbi-gene-human, ncbi-gene-mouse, ncbi-gene-rat, reactome-pathways, reactome-mappings. No mirror, no re-hosted bytes, and no locally-derived artifacts that no upstream serves.
- [x] 1.4 Split Reactome's identifier-mapping tables out of `reactome-pathways` into an opt-in `reactome-mappings` (`recommended: false`): upstream serves them only as uncompressed TSV totalling ~700 MB, so bundling them would make the recommended pathways dataset two orders of magnitude larger than the GMT that workflows actually use.
- [x] 1.4 Add `referenceArtifactKey` so resumable transfer state is keyed off catalog identity (`<id>/<version>/<path>`) rather than a URL that may move.
- [x] 1.5 Add pure dataset selection/install-plan resolution with typed unknown-id errors and deterministic ordering.
- [x] 1.6 Add the versioned receipt schema recording the **observed** size, digest, and integrity class per artifact, plus parsing helpers that degrade invalid metadata without hiding files.
- [x] 1.7 Export the catalog, integrity type, artifact key, selection, plan, receipt, and error types/functions through the curated harness barrel.
- [x] 1.8 Add contract tests for duplicate ids/destinations, traversal and absolute paths, non-`https` URLs, digests, sizes, the integrity-class split across the real catalog, multi-file plans, deterministic selection, and receipt validation.

## 2. Sandbox-Visible Reference Discovery

- [x] 2.1 Refactor the existing sandbox command path into one internal replay-safe exec runner shared by `execute_command` without changing its observable behavior.
- [x] 2.2 Convert `list_available_refs` into a dependency-bearing workflow-mode tool that uses the shared runner and inspects `/mnt/refs` inside the active sandbox.
- [x] 2.3 Implement confined optional-path resolution, no-follow symlink handling, bounded traversal/output, explicit truncation, and distinct unmounted/empty/populated result variants.
- [x] 2.4 Add optional harness-receipt and legacy `registry.json` enrichment that merges only existing paths and always retains unregistered filesystem entries.
- [x] 2.5 Wire the tool factory through sandbox-agent construction with the step's sandbox, function-id, deadline, and event dependencies.
- [x] 2.6 Update sandbox orientation/tool descriptions: the store is optional and may be absent, paths are never assumed or hardcoded, discovered paths are passed explicitly, and a library that resolves by env var (CellTypist) gets that var exported per-command from a path the inventory actually returned.

## 3. Sandbox Image

- [x] 3.1 Remove `ENV CELLTYPIST_FOLDER=/mnt/refs/celltypist_models` from the sandbox image and record why no library-specific reference path is compiled in: the store is optional and its layout is catalog-owned and versioned, so a baked path either dangles or pins the image to one catalog version.

## 4. Verification

- [x] 4.1 Add tool tests covering manifest-free user files, managed-plus-user merging, stale/invalid metadata, empty and absent mounts, traversal rejection, symlinks, and bounded deep trees.
- [x] 4.2 Extend sandbox-agent tool-surface and replay/durability tests for the new dependency-bearing workflow-mode discovery tool.
- [x] 4.3 Run targeted formatting, `tsc -p tsconfig.json`, and the relevant harness test suites.
