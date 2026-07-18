## Why

The Docker backend decides the `/mnt/refs` mount from a boot-frozen snapshot: `refs: !!config.refStorePath` trusts whatever the embedder resolved when the runtime booted. An embedder that gates the path on directory existence at boot (the CLI does exactly this) therefore freezes "no ref store" for the whole process lifetime — a user who installs reference data mid-session never gets `/mnt/refs` in any subsequent sandbox until restart. This silently breaks the last step of agent-triggered reference installs (inflexa#130 / inflexa#151), and is a correctness bug on its own: the sibling lib store already re-validates at every sandbox create (`libStoreUsable`), so the two stores disagree on when configuration is checked.

## What Changes

- The Docker backend re-checks `refStorePath` at **every sandbox create** instead of trusting the boot snapshot: the store is mounted iff the path is a real directory at create time. A store that appears mid-session is picked up by the next sandbox; a store that vanishes is skipped.
- The backend never binds a missing source — Docker would auto-create a root-owned directory at the path, littering the host and bricking a later store install (the same hazard `libStoreUsable` documents for libs).
- The create-time check is `lstat`-based and rejects symlinks: a bind authority must itself be a real directory, not an indirection that may later point outside user expectations. (This policy moves into the harness from the CLI's boot-time gate, which is deleted.)
- A missing ref store at create is treated as a **normal cold state** and skipped silently — deliberately unlike the libs re-check, whose missing-store path is a degradation and logs a warning. Logging on every create for users who never downloaded references would be noise.
- Embedder contract: pass `refStorePath` unconditionally (the configured store location); do not pre-gate it on existence at boot, or the harness can never observe a mid-session install.
- Kubernetes backend unchanged: a PVC mount has no host-existence concept.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `ref-store`: the Docker mount requirement changes from "bind-mount the host directory named by `refStorePath`" (implicitly trusting the configured value) to "re-check at each sandbox create: bind iff the path is a real directory at create time, never bind a missing source, and treat a missing store as a silent skip."

## Impact

- `src/sandbox/docker-client.ts` — the create-time mount decision (`refs:` input to `buildMountPlan` and the bind list) gains the existence check; `src/sandbox/docker-client.test.ts` mirrors the existing lib-recheck coverage.
- `src/sandbox/mount-plan.ts` — unchanged (`refs: boolean` input stays; only who computes it changes).
- Embedder (cli repo, wired at its pin bump): `existingRefStoreConfig`/`existingRefStorePath` and their test file are deleted; the composition root passes `refStorePath: env.refsDir` directly. Until then the harness behavior is strictly more permissive only for embedders that already pass the path unconditionally — none do, so there is no behavior change for existing embedders before the CLI wiring lands.
- Accepted edge (pre-existing class, now merely reachable mid-session): a sandbox created while a download is in flight can see an incomplete store. The mount is read-only and dataset completeness is receipt-gated on the embedder side, so this adds no new exposure over a store that existed at boot.
