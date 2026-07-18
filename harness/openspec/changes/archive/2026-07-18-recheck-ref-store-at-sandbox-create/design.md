## Context

Two gates decide the `/mnt/refs` mount today, and both freeze at embedder boot:

1. **Embedder boot gate (CLI):** `existingRefStoreConfig(env.refsDir)` omits `refStorePath` from `DockerClientConfig` entirely when the directory does not exist at boot. Once omitted, the harness has no path to re-check.
2. **Harness create-time read:** `createSandbox` computes `refs: !!config.refStorePath` — a pure read of the boot snapshot.

The sibling lib store already solves the inverse problem: `libStoreUsable(config.libStorePath)` runs at **every** sandbox create, because "the store may have gone away since boot." The ref store needs the mirror-image check — "the store may have *appeared* since boot" — but the fix must span both gates: the harness cannot re-check a path the embedder stripped.

The load-bearing hazard is documented on `libStoreUsable`: binding a missing source makes Docker auto-create a **root-owned** directory at that path. For refs that would both litter the host (the CLI's no-litter policy gates directory creation to deliberate actions) and brick the subsequent `refs download` (the store tool cannot write into a root-owned dir). So the create-time check is a correctness requirement, not an optimization.

## Goals / Non-Goals

**Goals:**

- A ref store installed mid-session is mounted into every sandbox created after it exists, without a runtime restart.
- The Docker backend never binds a missing bind source.
- The embedder contract becomes "pass the configured store location unconditionally"; existence is the harness's create-time concern.

**Non-Goals:**

- No change to the Kubernetes backend (`refStorePvc` is a PVC reference; host-existence has no meaning there — the `stores.refs` flag keeps its current derivation).
- No change to `mount-plan.ts` (`refs: boolean` input stays; only the Docker caller's computation of it changes).
- No completeness/receipt validation of store *content* — receipts are embedder-owned metadata; the harness check is existence-only, unlike the libs check which validates harness-known layout (`current` + completeness markers).
- No in-sandbox live visibility: a sandbox created *before* the install still lacks `/mnt/refs` for its lifetime. Freshness is per-create, matching libs.

## Decisions

**1. The check lives in the harness, hard-coded — not an embedder predicate seam.**
Alternatives: (a) an embedder-supplied `refStoreUsable?: (path) => boolean` config seam; (b) a thunk-shaped `refStorePath?: () => string | undefined`. Both keep policy embedder-side, but "a bind authority must be a real directory" is an engine fact about Docker bind mounts, not host policy — and both add seam surface for a one-line check. Rejected as over-engineering the boundary; the harness owns the check the same way it owns `libStoreUsable`.

**2. `lstat`-based, symlink-rejecting existence check.**
The CLI's boot gate deliberately rejects symlinks ("the configured path should itself be the deliberately created public store, not an indirection"). Deleting that gate would silently drop the policy, so it moves into the harness check verbatim: `lstatSync(path).isDirectory()`, throw → false. This differs from `libStoreUsable`'s `statSync` on purpose — libs *must* follow `current` because that indirection is the store's own layout; refs has no sanctioned indirection.

**3. Missing store at create is a silent skip, not a warning.**
The libs re-check warns on a missing store because that state is a *degradation* (it was configured and working, then broke). A missing ref store is the *normal cold state* — most users have downloaded nothing — and warning on every sandbox create would be noise. Asymmetry is deliberate and documented at the check site. (Debug-level logging is acceptable if useful; warn is not.)

**4. Embedder passes the path unconditionally; the boot gate is deleted, not bypassed.**
Leaving `existingRefStoreConfig` in place "for safety" would recreate the freeze — a half-migrated state where the harness re-checks a path that is sometimes absent from config. The CLI wiring becomes `refStorePath: env.refsDir` and the gate plus its test file are removed (no other consumers).

## Risks / Trade-offs

- [Sandbox sees an incomplete store mid-download] → Accepted. The mount is read-only and dataset completeness is receipt-gated embedder-side; the same window existed for stores present at boot. No new exposure class.
- [Store appears between the check and the bind (TOCTOU)] → Accepted; identical to the existing libs TOCTOU. The failure mode is benign: the bind either succeeds against the just-created dir or the create errors loudly.
- [Store *vanishes* between check and bind] → Docker auto-creates a root-owned dir — the pre-existing hazard, now bounded to a millisecond window instead of "any time after boot." Strictly better than today.
- [Embedders that already pass `refStorePath` unconditionally change behavior] → None exist (the CLI is the only known Docker embedder and it gates at boot). For such an embedder the change is that a missing path stops being bound-and-auto-created — a bug fix, not a regression.

## Migration Plan

1. Harness: add the create-time check + tests; update the `ref-store` spec delta; release.
2. Embedder (cli repo, at its harness pin bump): replace `...existingRefStoreConfig(env.refsDir)` with `refStorePath: env.refsDir`; delete `existingRefStorePath`/`existingRefStoreConfig` and `runtime_refs.test.ts`. Local development bridges the unreleased harness via `bun run harness:local`.

Rollback: revert the harness commit; the embedder wiring is forward-compatible with the old harness (an always-present `refStorePath` reproduces today's behavior for existing stores, and the missing-store case is the pre-existing auto-create hazard).

## Open Questions

None — the symlink policy, logging level, and seam shape were the open forks and are decided above.
