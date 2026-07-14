## 1. Public Store and Catalog Consumption

- [x] 1.1 Add `env.refsDir`, document it through `envDoc`, and cover platform/XDG resolution and no-litter path inspection in tests.
- [x] 1.2 Create the `modules/refs` feature slice consuming the harness catalog/install-plan/receipt barrel exports directly — no key-to-URL adapter and no distribution base: artifacts are fetched from the upstream URL the catalog names.
- [x] 1.3 Define the installer-owned `managed/` and `.inflexa/` paths plus the user-owned `user/` path, with helpers that never create state during passive inspection and refuse symlinked or unexpected installer-owned paths.

## 2. Store Inspection and Verification

- [x] 2.1 Implement receipt reads and cheap catalog/filesystem state classification for missing, installed, update-available, partial, and invalid-receipt datasets.
- [x] 2.2 Implement explicit verification of active managed files against the **receipt's** observed size and SHA-256, reporting per file which guarantee was checked (catalog digest for `pinned`, install-time digest for `unpinned`) without mutating disk.
- [x] 2.3 Add tests for absent stores, empty stores, valid installs, deleted/modified managed files, stale receipts, unknown top-level content, and untouched user data.

## 3. Verified Dataset Installation

- [x] 3.1 Implement streaming downloads from the catalog's upstream URLs to installer-owned `.part` files with typed network and filesystem errors, keyed off the artifact's catalog identity rather than its URL.
- [x] 3.2 Restrict HTTP Range resume to `pinned` artifacts and re-fetch `unpinned` ones whole, so a partial is never appended to bytes a mutable upstream may have replaced.
- [x] 3.3 Verify `pinned` artifacts against the catalog's size and SHA-256 before activation; for `unpinned` artifacts record the observed size and digest instead of checking against a digest the catalog cannot honestly carry.
- [x] 3.4 Implement atomic version activation, atomic receipts recording the **observed** bytes/digest/integrity per artifact, prior-version restore on every failure path, and removal of the per-attempt staging root so activation leaves no orphaned directories.
- [x] 3.5 Gate the "already installed" skip on a digest check of the active files, not a size check, so a same-size corruption re-downloads instead of being reported as installed; apply the same gate to the pre-transfer estimate.
- [x] 3.6 Report the download estimate as known catalog bytes plus a count of `unpinned` artifacts whose size only the upstream knows, without inventing a total.
- [x] 3.7 Add installer tests for multi-file activation, pinned resume, unpinned whole re-fetch, digest/size mismatch, interruption, prior-version preservation, staging cleanup, forced re-fetch, and refusal to overwrite unexpected managed or user paths.

## 4. Reference Command Surface

- [x] 4.1 Register `inflexa refs list`, `download [ids...] [--yes] [--force]`, `verify [ids...]`, and `path` with lazy feature imports and typed option parsing.
- [x] 4.2 Implement catalog/state rendering with versions, integrity class, sizes, recommendation groups, source/license links, and contribution guidance for missing options.
- [x] 4.3 Implement interactive multi-select and pre-transfer size confirmation plus explicit-id/`--yes` non-interactive behavior through the same headless install operation; `--force` re-fetches an intact install (repair, and the refresh path for a mutable upstream).
- [x] 4.4 Make `verify` name the repair command and exit non-zero on damage, and add command tests for unknown ids, declined downloads, headless consent, verification reporting, exact path output, and user-content notices.

## 5. Setup and Runtime Wiring

- [x] 5.1 Extend setup options with explicit reference selection/consent and add the interactive installed-state check and size-labelled selection using the reference download handler.
- [x] 5.2 Make setup deliberately create the store and `user/` namespace, continue on decline/empty selection, fail visibly on a selected install failure, and emit actionable headless guidance when no explicit selection is supplied.
- [x] 5.3 Condition the harness composition's `refStorePath` on the pre-existing `env.refsDir`, including an existing empty directory while omitting an absent one.
- [x] 5.4 Add setup and runtime-composition tests proving handler reuse, no silent headless download, no passive directory creation, read-only mount wiring, and the missing-bind-source guard.

## 6. Verification

- [x] 6.1 Remove `INFLEXA_REFERENCE_DATA_BASE_URL` from `env`/`envDoc` and update user-facing help/README for the host path, `/mnt/refs` mapping, upstream-only sourcing, integrity classes, managed/user ownership, offline sandbox behavior, and the catalog contribution workflow.
- [x] 6.2 Run targeted source formatting, `bun run typecheck`, `bun run lint`, and the relevant CLI test suites.
