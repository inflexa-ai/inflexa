## Why

The sandbox mount contract for the library store already exists in the harness: `create-sandbox.ts` accepts an optional `libStorePath`, `docker-client.ts:118` bind-mounts it read-only (`${libStorePath}:/mnt/libs:ro`), and the active store is `/mnt/libs/current`. But **the CLI never populates `libStorePath`** — there is no way for a user to obtain the store, no place it lives on disk, and no code that points the harness config at it. So today the harness runs every sandbox with no `/mnt/libs`, `list_available_packages` returns `available:false`, and the planner writes analysis code against packages that aren't there.

The companion build change (`harness/openspec/changes/add-lib-store-bundles-and-validation`) publishes the store as **per-track, content-addressed, immutable tarballs** selected into named bundles, with a per-bundle-per-arch manifest and a `latest` pointer that only advances onto a validated version. That change explicitly lists this CLI pull handler as a **hard dependency of its Gate 2** ("validate as a user" is meaningless until a real user download path exists). This change builds that path.

The priority is **UX and "it just works."** A user should never need to understand tracks, R triples, or architectures — those are our problem. From the user's chair there are two facts: *do I need R?* and *is it ready yet?* Everything else is inferred or shown as progress.

## What Changes

- **`inflexa libs pull [bundle]`** — the one dogfooded handler. Detects arch (`uname -m`), resolves a bundle to a manifest, computes a download plan (skipping track digests already held), downloads missing tracks **in parallel** to `.part` files, verifies each sha256, extracts into a **staging** version dir, concatenates the tracks' `packages.txt` fragments, then **atomically flips a `current` symlink** onto the new version. Adds `libs status` and `libs list`.
- **Atomic, versioned, on-disk store** under `join(dataDir(),"inflexa","libs")` — `current -> <version>/` beside `models/`, `sessions/`, `postgres/`. A sandbox launched mid-pull sees the old `current` or the new one, never a torn tree. This is the `.part`→atomic-rename pattern the embedding downloader (`embedding/setup.ts:97`) already uses, one level up.
- **Setup-flow wiring.** `inflexa setup` (`infra/setup.ts`) gains one `@clack/prompts` `select()` — "Full (Python + R + conda, recommended) / Core (Python + conda, smaller)" — then a `spinner()` around the same handler. On arm64 only Core is offered, with a `note()` on why R isn't available yet. The Q&A and provisioning reuse the pull handler; no second code path.
- **Lazy detection** before a sandbox launches: if `current` is absent, surface a one-line offer to run `inflexa libs pull` — an **offer, not a blocker**, because a missing store is degraded (`available:false`), not fatal.
- **Config knob + the coupling guard.** Add `libStorePath?` to the CLI config schema (default the data-dir path). The harness config builder (`modules/harness/config.ts`) sets `libStorePath` on the sandbox config **only when `current` actually exists** — because Docker auto-creates a missing bind source as a root-owned empty dir, which would silently mount an empty store.
- **`--version` targeting.** Pull resolves `latest` by default but accepts an explicit version, so the build change's **Gate 2 validator pulls the candidate** through this exact handler before `latest` is promoted.

## Capabilities

### New Capabilities
- `lib-store-provisioning`: how the CLI obtains, versions, and activates the sandbox library store on the user's machine — the `inflexa libs pull|status|list` commands, the atomic versioned on-disk layout with the `current` pointer, manifest resolution + per-track digest dedup + parallel resumable download + sha256 verification, `packages.txt` assembled from the pulled tracks, the setup-flow wiring, lazy detection, and the config coupling that only mounts a store that exists. Owns the invariant *the mounted `/mnt/libs/current` is always a complete, verified store or absent — never partial*. The client half of the build change's producer/consumer contract.

### Modified Capabilities
- None. The harness runtime mount contract (`harness/openspec/specs/lib-store`) is unchanged — this change produces the host directory that contract already knows how to mount. The `harness-runtime` composition is only *wired* (it gains a `libStorePath` when the store exists); no requirement of it changes.

## Impact

- **New**: `src/modules/libs/` — `pull.ts` (the handler), `manifest.ts` (resolve + verify), `store.ts` (on-disk layout, staging, atomic swap, prune), `bundles.ts` (arch → bundle resolution). New `libs` command group in `src/cli/index.ts`.
- **Modified**: `src/lib/config.ts` (+`libStorePath?`), `src/lib/env.ts` (+`libStorePath` = `join(dataDir(),"inflexa","libs")`, documented in `envDoc`), `src/modules/harness/config.ts` (set `libStorePath` iff `current` exists), `src/modules/infra/setup.ts` (bundle `select()` + spinner), the sandbox-launch path (lazy offer).
- **Config**: the published-store base URL — a baked-in default (public bucket/CDN) overridable by env/config. The OSS bucket must be public-read for a no-auth pull.
- **Dependency**: unblocks Gate 2 of `add-lib-store-bundles-and-validation`; consumes the manifest format that change defines.
- **Deferred**: arm64 has no R tarballs (upstream: r2u is amd64-only), so `full` is unavailable there — surfaced as a UX message, not an error. The dedup *mechanism* (blob cache vs reflink/hardlink between versions) is left to design.
