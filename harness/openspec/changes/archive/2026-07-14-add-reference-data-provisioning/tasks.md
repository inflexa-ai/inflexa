## 1. Catalog and Receipt Contracts

- [x] 1.1 Add the reference-data catalog schema, trusted catalog data, safe relative-path validation, and catalog-version contract under `src/reference-data/`.
- [x] 1.2 Add pure dataset selection/install-plan resolution with typed unknown-id errors and deterministic ordering.
- [x] 1.3 Add the versioned reference installation receipt schema and parsing helpers that degrade invalid metadata without hiding files.
- [x] 1.4 Export the catalog, selection, plan, receipt, and error types/functions through the curated harness barrel.
- [x] 1.5 Add catalog contract tests for duplicate ids/destinations, traversal and absolute paths, digests, sizes, multi-file plans, deterministic selection, and receipt validation.

## 2. Sandbox-Visible Reference Discovery

- [x] 2.1 Refactor the existing sandbox command path into one internal replay-safe exec runner shared by `execute_command` without changing its observable behavior.
- [x] 2.2 Convert `list_available_refs` into a dependency-bearing workflow-mode tool that uses the shared runner and inspects `/mnt/refs` inside the active sandbox.
- [x] 2.3 Implement confined optional-path resolution, no-follow symlink handling, bounded traversal/output, explicit truncation, and distinct unmounted/empty/populated result variants.
- [x] 2.4 Add optional harness-receipt and legacy `registry.json` enrichment that merges only existing paths and always retains unregistered filesystem entries.
- [x] 2.5 Wire the tool factory through sandbox-agent construction with the step's sandbox, function-id, deadline, and event dependencies.
- [x] 2.6 Update sandbox orientation/tool descriptions to explain dynamic mounted discovery, user-added references, and the continued prohibition on runtime downloads.

## 3. Verification

- [x] 3.1 Add tool tests covering manifest-free user files, managed-plus-user merging, stale/invalid metadata, empty and absent mounts, traversal rejection, symlinks, and bounded deep trees.
- [x] 3.2 Extend sandbox-agent tool-surface and replay/durability tests for the new dependency-bearing workflow-mode discovery tool.
- [x] 3.3 Run targeted formatting, `tsc -p tsconfig.json`, and the relevant harness test suites.
