## 1. Projection types and builders (`src/modules/refs/store.ts`)

- [x] 1.1 Export the list-projection type (store-level: root/exists/userContent; per-dataset: id, version, title, description, sourceUrl, license, group, recommended, state, optional installedVersion/installedAt, artifacts) and a pure builder from `ReferenceStoreInspection` + the store root, copying every field by name (design decisions 1 and 4: CLI-owned shape, recommendation flattened, receipt exposure limited, optional facts as absent keys). JSDoc the type as the documented wire shape and the in-process surface for planner ref-awareness.
- [x] 1.2 Export the verify-projection type (object wrapping the dataset array: datasetId, optional version, state, per-file states) and its pure builder from `ReferenceVerification[]` (design decision 5).
- [x] 1.3 Unit tests in `store.test.ts`: builders copy field-by-name, omit keys (not `null`) when no valid receipt exists, preserve catalog order, and pin key order (serialize twice → byte-identical).

## 2. Command JSON branches (`src/modules/refs/commands.ts`)

- [x] 2.1 `runRefsList`: accept a `json` option; when set, print exactly `JSON.stringify(projection, null, 2)` + trailing newline on stdout and nothing else; failure path prints prose to stderr and sets exit code 1 with empty stdout. Human branch byte-untouched; `--urls` has no effect on the document.
- [x] 2.2 `runRefsVerify`: accept a `json` option; when set, emit the verify document on stdout; damaged datasets still set exit code 1 but the advisory "Re-download to repair" stderr hint is suppressed (design decision 7); operation failure → empty stdout, prose stderr, exit 1. Selection logic (no-ids → receipted/invalid datasets) unchanged.

## 3. CLI registration (`src/cli/index.ts`)

- [x] 3.1 Add `--json` with a docs-gen-satisfying description to `refs list` and `refs verify`, threading the flag into the lazy-imported actions.

## 4. Tests for the command contract (`src/modules/refs/commands.test.ts`)

- [x] 4.1 JSON list: one document on stdout covering every catalog dataset in catalog order; installed dataset carries installedVersion/installedAt from the receipt; artifact URLs present with no extra flag; `--json --urls` output byte-identical to `--json` alone.
- [x] 4.2 Byte-stability + no-litter: two runs before the store exists → byte-identical stdout, no directory created.
- [x] 4.3 Failure purity: inspection/verification failure in JSON mode → empty stdout, prose on stderr, exit code 1.
- [x] 4.4 JSON verify: damaged file → document names dataset/file states, exit code 1, no repair hint on stderr; intact store → document with valid states, exit code 0.

## 5. Verification

- [x] 5.1 `bun run typecheck`, `bun run lint`, `bun test` green; `bun run format:file` on the changed `src/` files.
- [x] 5.2 `bun scripts/gen_docs.ts` succeeds (option descriptions satisfy the docs-gen gate) — run as a plain subprocess, never under `bun test`.
- [x] 5.3 Acceptance against issue #152 "Done when": `inflexa refs list --json` emits per-dataset install state in the documented shape; human output of `refs list`/`refs verify` is unchanged (diff a before/after capture).
