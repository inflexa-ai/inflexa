# Tasks

> Depends on the harness change `add-layered-sandbox-images` (images + GHCR
> publish must exist for the pull to resolve).

## 1. `inflexa sandbox pull` replaces the tarball pull

- [x] 1.1 Register the `sandbox` command group (`sandbox pull`, `sandbox status`) in `src/cli/`, renamed from the `libs` group. Rework `src/modules/libs/pull.ts` into a variant selector (`python` | `python-r`) that `docker pull`s `ghcr.io/inflexa-ai/inf-cli/sandbox-<variant>` via the active runtime and writes `harness.sandboxImage`.
- [x] 1.2 Make pull idempotent (present + current → "up to date"); support `--yes` and a variant arg for non-interactive use.
- [x] 1.3 Rework `offerLibStoreIfMissing` → offer to run `inflexa sandbox pull`. Folded into `ensureSandboxImage` (profile.ts): a missing configured image is offered (one line, naming the variant) then pulled from GHCR — the standalone offer is subsumed by the pre-flight. Setup's non-fatal offer lives in `runSandboxImageSetup`.

## 2. Config + runtime wiring

- [x] 2.1 Point `DEFAULT_SANDBOX_IMAGE` at the GHCR tag; keep `harness.sandboxImage` as the user override.
- [x] 2.2 Remove `resolveLibStore` and the `libStorePath` / `sandboxPlatform` derivation from the local harness-runtime composition (no bind mount, no forced platform).
- [x] 2.3 Change `ensureSandboxImage` to `docker pull` from GHCR when the configured image is absent (offer interactively, `--yes`/non-interactive pulls directly); optional build-from-source fallback for a locally-tagged image.

## 3. Retire the tarball client

- [x] 3.1 Delete `src/modules/libs/{store,manifest,arch}.ts` and their tests (per-track download, digest dedup, staging, assembly, arch mapping).
- [x] 3.2 Remove dead imports/config (`libStoreUrl`, `INFLEXA_LIB_STORE_URL`, `env.libStorePath`) no longer referenced by the local path.
- [x] 3.3 Grep for orphaned references to `libStorePath`, `packages.txt` assembly, `meta.json` arch, and `current` symlink; remove.

## 4. Status + docs

- [x] 4.1 Rework `inflexa sandbox status` (renamed from `inflexa libs status`) to report the configured variant, GHCR reference, local presence, and digest.
- [x] 4.2 Update setup/onboarding docs to present `inflexa sandbox pull <variant>` as the one-step local path.

## 5. Validation

- [x] 5.1 `openspec validate switch-cli-to-sandbox-images --strict` passes.
- [x] 5.2 `bun test` green after the tarball-client removal; update/remove tests that assumed a mounted store.
