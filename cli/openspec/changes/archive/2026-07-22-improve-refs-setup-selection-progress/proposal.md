## Why

The reference-data step of `inflexa setup` opens with 32 of the catalog's 56 datasets already ticked, so a first-run user meets a wall of preselected entries ("38 files of upstream-determined size") and has to deselect their way out of a choice they never made. The transfer that follows is then completely silent — `installReferenceDatasets` streams every artifact to disk and prints nothing until the whole plan finishes, so a multi-gigabyte download is indistinguishable from a hang.

## What Changes

- **Selection becomes an up-front preset choice instead of a preselected wall.** Interactive setup (and interactive `inflexa refs download` with no ids) first asks for a preset over the datasets it actually offers: **all**, **recommended**, **none**, or an explicit escape into the per-dataset picker.
- **The per-dataset picker starts empty.** The existing grouped multi-select is kept as the "choose specific datasets" escape, but with nothing preselected, so a user opting into it builds a selection up rather than tearing one down. **BREAKING** for anyone who relied on "press Enter at the picker installs the recommended set" — that outcome is now the explicit `recommended` preset.
- **The `none` preset explains how to get references later**, truthfully: run `inflexa refs download <id>` when a dataset is wanted, or ask the agent in chat — it drives the same command through `run_inflexa`, which is registered `approval`, so the user only has to approve the proposal.
- **The transfer reports combined progress.** One readout for the whole plan: files completed of the planned total, cumulative bytes downloaded, and a current transfer rate.
- **The store gains a headless progress seam** — an optional reporter on the install dependencies — so byte-level events reach the CLI without `store.ts` learning anything about terminals. All rendering stays in the refs command layer.
- **Byte formatting becomes a global extension.** `Number.prototype.formatBytes()` replaces the module-local `formatReferenceBytes`, which is deleted rather than shimmed, and absorbs the hand-rolled byte string in the embedding setup step so one formatter really is the only one. It renders `B`/`KB`/`MB`/`GB` on a 1024 base — the vocabulary the rest of the wizard already prints — so the refs summary stops being the one line in setup that says `GiB`.
- **No new dependencies**: `@clack/prompts` (already used across setup) provides both the preset select and the progress renderer.

## Capabilities

### New Capabilities

None. This change reshapes an existing interactive flow and its reporting; no new capability is introduced.

### Modified Capabilities

- `reference-data-provisioning`: interactive selection gains the preset step and an empty-by-default picker; the download requirement gains combined progress reporting during transfer; the setup requirement is restated around presets while keeping consent, decline, shared-installer, and headless guarantees intact.
- `unit-test-coverage`: the "Global extensions are tested" requirement enumerates the extensions under test and must name `Number.prototype.formatBytes`.

## Impact

- `src/modules/refs/commands.ts` — `chooseIds` gains the preset step; `formatReferenceBytes` is deleted; the download path renders combined progress and passes the reporter down.
- `src/modules/refs/store.ts` — `ReferenceInstallDeps` gains the optional progress reporter; `downloadArtifact` emits byte deltas while streaming. Install semantics, the `Result` contract, staging, activation, and receipts are untouched.
- `src/extensions/number.ext.ts` (new) + `src/extensions/index.ts` — the byte formatter and its registration.
- `src/modules/infra/setup.ts` — unchanged call site; it already delegates to `runReferenceSetup`.
- `src/modules/embedding/setup.ts` — its one hand-rolled byte string moves onto the shared formatter.
- Tests: `src/modules/refs/commands.test.ts`, `src/modules/refs/store.test.ts`, `src/extensions/extensions.test.ts`.
- Unchanged by construction: `refs list`/`verify` JSON modes and their byte-stability, `setup --refs <ids>`, and headless setup's recommended-set-under-`--yes` behavior.
