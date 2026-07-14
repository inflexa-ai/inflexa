## Why

Local sandboxes support a read-only reference-data mount, but the CLI neither exposes a stable host directory nor provisions or wires it. Users need a visible place for their own references and an optional, verified download path for the canonical catalog shared with managed deployments.

## What Changes

- Add a documented reference-store directory under the platform data home and mount it read-only at `/mnt/refs` whenever it deliberately exists.
- Add `inflexa refs list`, `download`, `verify`, and `path` actions backed by the harness-owned catalog and a local artifact-location adapter.
- Install managed datasets into a reserved namespace using resumable staging, per-file checksum verification, receipts, and atomic activation without modifying user-owned content.
- Reserve and document a `user/` namespace where users may place arbitrary reference data that future sandboxes discover automatically.
- Extend interactive `inflexa setup` to inspect installed references and offer catalog selections through the same download handler; headless setup never downloads large data without explicit selection and consent.
- Tell users how to contribute new catalog entries by pull request when an option is missing.

## Capabilities

### New Capabilities

- `reference-data-provisioning`: The local reference-store path, catalog-driven commands, verified installer, receipts, user-owned namespace, and setup integration.

### Modified Capabilities

- `harness-runtime`: The local composition root conditionally supplies the existing reference-store directory as `refStorePath` so Docker sandboxes receive the read-only mount without auto-creating a missing host path.

## Impact

- Adds a `src/modules/refs/` feature slice and command group; updates `src/lib/env.ts`, root help, setup, and harness runtime composition.
- Consumes the harness's new catalog/install-plan exports and supplies the public artifact resolver and local filesystem adapter.
- Adds persistent data under the CLI's platform data directory; user content is outside installer ownership and is never pruned or overwritten.
