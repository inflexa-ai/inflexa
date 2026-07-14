## 1. Public Store and Catalog Adapter

- [x] 1.1 Add `env.refsDir`, document it through `envDoc`, and cover platform/XDG resolution and no-litter path inspection in tests.
- [x] 1.2 Create the `modules/refs` feature slice with a public-artifact-key resolver consuming only the harness catalog/install-plan barrel exports.
- [x] 1.3 Define the installer-owned `managed/` and `.inflexa/` paths plus the user-owned `user/` path, with helpers that never create state during passive inspection.

## 2. Store Inspection and Verification

- [x] 2.1 Implement receipt reads and cheap catalog/filesystem state classification for missing, installed, update-available, partial, and invalid-receipt datasets.
- [x] 2.2 Implement explicit verification of active managed files against receipt/catalog size and SHA-256 without mutating disk.
- [x] 2.3 Add tests for absent stores, empty stores, valid installs, deleted/modified managed files, stale receipts, unknown top-level content, and untouched user data.

## 3. Verified Dataset Installation

- [x] 3.1 Implement missing-byte install planning and resumable streaming downloads to installer-owned `.part` files with typed network and filesystem errors.
- [x] 3.2 Implement size/SHA-256 verification and safe placement of final-file artifacts into a per-attempt dataset staging directory.
- [x] 3.3 Implement atomic immutable-version activation and atomic harness-compatible receipt writes that preserve the prior active version on every failure path.
- [x] 3.4 Add installer tests for successful multi-file activation, resume, digest/size mismatch, interruption, prior-version preservation, and refusal to overwrite unexpected managed or user paths.

## 4. Reference Command Surface

- [x] 4.1 Register `inflexa refs list`, `download [ids...]`, `verify [ids...]`, and `path` with lazy feature imports and typed option parsing.
- [x] 4.2 Implement catalog/state rendering with versions, sizes, recommendation groups, source/license links, and contribution guidance for missing options.
- [x] 4.3 Implement interactive multi-select and pre-transfer size confirmation plus explicit-id/`--yes` non-interactive behavior through the same headless install operation.
- [x] 4.4 Add command tests for unknown ids, declined downloads, headless consent, verification reporting, exact path output, and user-content notices.

## 5. Setup and Runtime Wiring

- [x] 5.1 Extend setup options with explicit reference selection/consent and add the interactive installed-state check and size-labelled selection using the reference download handler.
- [x] 5.2 Make setup deliberately create the store and `user/` namespace, continue on decline/empty selection, fail visibly on a selected install failure, and emit actionable headless guidance when no explicit selection is supplied.
- [x] 5.3 Condition the harness composition's `refStorePath` on the pre-existing `env.refsDir`, including an existing empty directory while omitting an absent one.
- [x] 5.4 Add setup and runtime-composition tests proving handler reuse, no silent headless download, no passive directory creation, read-only mount wiring, and the missing-bind-source guard.

## 6. Verification

- [x] 6.1 Update user-facing help/documentation for the host path, `/mnt/refs` mapping, managed/user ownership, offline sandbox behavior, and catalog contribution workflow.
- [x] 6.2 Run targeted source formatting, `bun run typecheck`, `bun run lint`, and the relevant CLI test suites.
