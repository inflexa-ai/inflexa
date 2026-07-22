## Why

The reference step of `inflexa setup` now leads with a preset choice — Recommended / Everything / Nothing / "choose specific datasets…". Two things are wrong with it in practice.

**The recommended preset vanishes exactly when it is most confusing.** Presets resolve against the datasets setup is *offering*, which excludes anything already installed and intact. The catalog carries 56 datasets, 32 of them recommended; once someone installs the recommended set, the offered set is the 24 optional ones and *none* of them are recommended, so the prompt drops the Recommended entry entirely. A returning user sees Everything / Nothing / Choose, with no explanation for what happened to the option they used last time — and no hint that the missing entry is a consequence of a *successful* prior install.

**A preset names a set without showing it.** Choosing "Recommended" installs 32 datasets the user never sees listed. The per-dataset picker — the view that does show them — is buried one level down as an escape hatch, so the common path never displays what it is about to download.

## What Changes

- **BREAKING (interactive UX)**: the preset `select` is removed. Interactive selection with no explicit ids goes straight to the per-dataset picker — the grouped, labelled listing of every offered dataset — which remains the single selection surface.
- The picker gains **bulk-selection keys**: `a` selects every offered dataset, `n` clears the selection, `r` selects the recommended subset of the offered set. Each replaces the current selection outright; they compose with ordinary space-toggling and group toggling. `r` is inert rather than clearing when nothing offered is recommended, so a key labelled "recommended" can never mean "none".
- The picker keeps opening with **nothing selected**, and a visible footer states the keys, so bulk selection costs one keystroke while narrowing a selection still never requires deselection.
- Before the picker, setup and `refs download` **disclose what is not in the list**: how many datasets are already installed and intact.
- When the recommended key has nothing to select, the legend **names the install that emptied it** — `r recommended (32 already installed)` — rather than the bare `(none offered)`, which states the symptom and withholds the cause. The neutral wording survives only for an offer that genuinely never had a recommendation.
- The on-demand note is stated **before the choice** rather than after an empty one: references can be fetched later with `inflexa refs download <id>`, or by asking the agent, which proposes that command for approval. On a terminal wide enough it is **floated as a bordered panel down the right-hand side of the picker**, where it stays visible while the listing scrolls and costs no vertical space; on a narrower one it falls back to prose above the list.
- `refs download` with no ids offers the same not-yet-installed set as setup, except under `--force`, where every dataset is genuinely re-fetchable and all of them are offered.

Unchanged: headless setup still defaults to the recommended set gated on `--yes`; `setup --refs <ids>` and `refs download <ids>` still bypass selection entirely; consent still precedes every transfer; cancelling still transfers nothing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-data-provisioning`: replaces the preset-choice requirements on "Reference commands expose install, verification, and path operations" and "Setup reuses the reference download handler" with the picker-plus-bulk-keys contract, the already-installed disclosure, and the placement of the on-demand note.

## Impact

- `cli/src/modules/refs/commands.ts` — removes `ReferencePreset`, `referencePresetPrompt`, and `resolveReferencePreset`; adds the picker model, its bulk-key resolution, and the pre-prompt disclosure.
- `cli/package.json` — declares `@clack/core` at the exact version `@clack/prompts@1.7.0` already resolves (`1.4.3`). `@clack/prompts`' `groupMultiselect` returns the prompt promise and exposes no instance, so custom key handling requires constructing `GroupMultiSelectPrompt` directly. Approved for this change.
- `cli/src/modules/refs/commands.test.ts` — preset tests give way to picker-model, bulk-key, and disclosure tests.
- No change to `store.ts`, the install path, the progress readout, JSON modes, or any non-interactive behavior.
