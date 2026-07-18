## Why

Programmatic consumers have no way to learn reference-store install state: `inflexa refs list` prints human prose only, so the only machine path today is scraping it. The planner ref-awareness work (inflexa#155) needs a reliable installed-ref inventory to plan against, and out-of-process consumers (scripts, tests, the chat agent shelling out to the CLI) benefit from the same contract. This is issue inflexa#152, a child of the inflexa#130 agent-triggered reference-install design.

## What Changes

- `inflexa refs list --json` emits the reference-store inspection — per-catalog-dataset install state plus store-level facts — as a documented, byte-stable JSON document on stdout.
- `inflexa refs verify --json` emits the per-dataset verification results as the same kind of documented JSON document.
- The wire shape is a **CLI-owned projection type** exported from `modules/refs` — an explicitly constructed serialization, not a raw dump of the harness catalog types — so the CLI owns the stability promise and the planner work (inflexa#155) can import the same type in-process instead of scraping its own CLI.
- The JSON is self-contained: artifact upstream URLs are always included, so `--json` composes with no other flag (`--urls` remains a human-output-only concern).
- Failure contract: in JSON mode stdout stays pure — a complete JSON document or nothing. Errors remain prose on stderr with exit code 1, exactly as the human mode behaves today.
- No change to the human-readable output of either command.

## Capabilities

### New Capabilities

<!-- none — this extends the existing reference-data command surface -->

### Modified Capabilities

- `reference-data-provisioning`: the reference commands requirement gains a machine-readable output mode — `refs list --json` and `refs verify --json` emit a documented, byte-stable, side-effect-free JSON projection of install/verification state.

## Impact

- `cli/src/modules/refs/store.ts` or a sibling in the module — the exported projection type(s) and the pure builder(s) from `ReferenceStoreInspection` / `ReferenceVerification`.
- `cli/src/modules/refs/commands.ts` — `runRefsList` / `runRefsVerify` gain the JSON branch (human path untouched).
- `cli/src/cli/index.ts` — `--json` option registration on `refs list` and `refs verify`, each with a description (docs-gen fails on undescribed options).
- `cli/src/modules/refs/commands.test.ts` / `store.test.ts` — coverage for shape, byte-stability, stdout purity, and the no-litter guarantee (inspection never creates the store).
- No harness change, no new dependencies.
