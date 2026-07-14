## Why

Local sandboxes support a read-only reference-data mount, but the CLI neither exposes a stable host directory nor provisions or wires it. Users need a visible place for their own references and an optional, verified download path for the canonical catalog shared with managed deployments.

Those downloads must come from the party that publishes them. The catalog's provenance and licence links are only true of the upstream it names, so the CLI has no distribution endpoint to configure — it fetches from NCBI, Reactome, WikiPathways, Zenodo, GTEx, and CellTypist directly.

## What Changes

- Add a documented reference-store directory under the platform data home and mount it read-only at `/mnt/refs` whenever it deliberately exists.
- Add `inflexa refs list`, `download`, `verify`, and `path` actions backed by the harness-owned catalog, fetching every artifact straight from the upstream URL the catalog names. There is no mirror, no re-hosting, and no `INFLEXA_REFERENCE_DATA_BASE_URL` — a configurable source is a source that can be substituted.
- Install managed datasets with resumable staging, per-file verification, receipts, and atomic activation without modifying user-owned content: a `pinned` artifact is checked against the catalog's size and SHA-256 before activation; an `unpinned` one has no catalog digest to check, so the receipt records the bytes actually received.
- Resume (HTTP Range) only `pinned` artifacts; re-fetch an `unpinned` artifact whole, since appending to bytes a mutable upstream has since replaced would splice two files together.
- Add `refs download --force` to re-fetch an intact install — the repair path for local damage and the only way to refresh a dataset whose mutable upstream has moved on.
- Gate the "already installed, nothing to do" skip on digests rather than sizes, so a same-size corruption is repaired instead of being silently reported as installed.
- Reserve and document a `user/` namespace where users may place arbitrary reference data that future sandboxes discover automatically.
- Extend interactive `inflexa setup` to inspect installed references and offer catalog selections through the same download handler; headless setup never downloads large data without explicit selection and consent.
- Tell users how to contribute new catalog entries by pull request when an option is missing.

## Capabilities

### New Capabilities

- `reference-data-provisioning`: The local reference-store path, catalog-driven commands, upstream-sourced verified installer, integrity-class-aware resume/verify, receipts, user-owned namespace, and setup integration.

### Modified Capabilities

- `harness-runtime`: The local composition root conditionally supplies the existing reference-store directory as `refStorePath` so Docker sandboxes receive the read-only mount without auto-creating a missing host path.

## Impact

- Adds a `src/modules/refs/` feature slice and command group; updates `src/lib/env.ts`, root help, setup, and harness runtime composition.
- Consumes the harness's catalog/install-plan/receipt exports; supplies only the local filesystem and transfer behavior, never an alternative source.
- Adds persistent data under the CLI's platform data directory; user content is outside installer ownership and is never pruned or overwritten.
