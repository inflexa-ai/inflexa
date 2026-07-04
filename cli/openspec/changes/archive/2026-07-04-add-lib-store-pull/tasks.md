## 1. On-disk store + atomic activation (`src/modules/libs/store.ts`)

- [x] 1.1 Define the layout under `libStorePath`: `current -> <version>/`, per-version dirs (`r/{cran,bioconductor,github}`, `python`, `node/node_modules`, `conda/bin`, `packages.txt`), a `.staging-<version>/` work dir, and the dedup cache dir. Match the fixed subpaths in `harness/src/sandbox/mount-plan.ts:69`.
- [x] 1.2 Implement staging → version rename + `current` symlink swap as an atomic activation (temp symlink `rename()` over `current`; same-filesystem staging so the dir rename is atomic).
- [x] 1.3 Implement `readActive()` (resolve `current` → {bundle, version, arch}) and `prune(keepN)` that never removes the version `current` points at.

## 2. Manifest resolve + verify (`src/modules/libs/manifest.ts`)

- [x] 2.1 Resolve the base URL: `INFLEXA_LIB_STORE_URL` env → config → compiled default (public bucket/CDN). Anonymous GET, no credentials.
- [x] 2.2 Fetch `latest/<bundle>/<arch>/manifest.json` (or `<version>/…` when `--version`); parse `{ track → {url, sha256, size} }` with a zod schema.
- [x] 2.3 sha256 helper reused for both download verification and dedup-by-digest (mirror `embedding/setup.ts`'s `Bun.CryptoHasher` usage).

## 3. Bundle + arch resolution (`src/modules/libs/bundles.ts`)

- [x] 3.1 `detectArch()` via `uname -m` → `linux-amd64` | `linux-arm64`.
- [x] 3.2 Map the two user bundles to track sets: full = `{python,conda,node,cran,bioconductor,github}`, core = `{python,conda,node}`. arm64 has no full — return an explained unavailability, fall back to core.
- [x] 3.3 Default bundle: full@amd64, core@arm64 (used by the no-arg pull and non-interactive setup).

## 4. The pull handler (`src/modules/libs/pull.ts`)

- [x] 4.1 `libsPull(bundle?, {core?, full?, version?, yes?})`: resolve arch+bundle → manifest → plan (skip held digests) → show download size → confirm (unless `--yes`/non-interactive).
- [x] 4.2 Download missing tracks in parallel to `.part`, verify sha256, keep in the dedup cache; extract each into `.staging-<version>/`.
- [x] 4.3 Assemble `packages.txt` by concatenating exactly the pulled tracks' fragments; cheap local sanity (non-empty, expected subtrees present).
- [x] 4.4 Activate via `store.ts`; report result. Re-pull-when-current short-circuits to "up to date".
- [x] 4.5 Pick the dedup mechanism per design (A: blob cache, recommended v1) and implement the "already held" check against it.

## 5. Command surface (`src/cli/index.ts` + `src/modules/libs/`)

- [x] 5.1 Register the `libs` command group; `libs pull <bundle?>` with `--core/--full/--version/--yes`, lazy-importing `pull.ts` (follow the `project` subcommand pattern at `index.ts:159`).
- [x] 5.2 `libs status` — location, active bundle/version/arch, present tracks, advertised package count, up-to-date check; "no store" path points at `libs pull`.
- [x] 5.3 `libs list` — bundles resolvable for the detected arch.

## 6. Config + env wiring

- [x] 6.1 Add `libStorePath?` to the config schema (`src/lib/config.ts`) and `libStorePath = join(dataDir(),"inflexa","libs")` to `src/lib/env.ts`, documented in `envDoc`.
- [x] 6.2 In `src/modules/harness/config.ts`, set the sandbox `libStorePath` **iff** `exists(join(libRoot,"current"))` — the coupling guard against Docker's root-owned-empty-dir auto-create.

## 7. Setup flow + lazy detection

- [x] 7.1 In `src/modules/infra/setup.ts`, add a `select()` (full/core; core-only + `note()` on arm64) and run `libsPull` inside a `spinner()`. Non-interactive → default bundle, no prompt.
- [x] 7.2 Add the pre-launch lazy check: if no `current`, print a one-line offer (with size) to run `inflexa libs pull`; continue without the store (never block).

## 8. Tests

- [x] 8.1 Atomic activation: assert `current` only ever names a complete version; a failed pull leaves the prior `current` intact; a mid-pull reader never sees `.staging`.
- [x] 8.2 Dedup: a second pull pinning a held digest downloads zero bytes for that track; a sha256 mismatch fails loud and leaves `current` unchanged.
- [x] 8.3 Bundle/arch resolution: arm64+full is rejected-with-reason → core; defaults resolve correctly per arch; `packages.txt` == concat of pulled fragments (core has no R).
- [x] 8.4 Coupling guard: harness config leaves `libStorePath` unset with no `current`, sets it once `current` exists.

## 9. Spec + docs

- [x] 9.1 On archive, sync the `lib-store-provisioning` capability into `cli/openspec/specs/`.
- [x] 9.2 Document `inflexa libs` + the store location + `INFLEXA_LIB_STORE_URL` in the CLI docs; note that Gate 2 of the build change consumes this handler via `--version`.
- [x] 9.3 Record deferred items (arm64 full; dedup mechanism A-vs-B; blob GC/`--reclaim`; private/auth'd stores) where a future reader will find them.
