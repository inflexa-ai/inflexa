# Design — Per-Analysis Farm Mount

## Context

Today the store selects one active farm through the `current` symlink at its
root. Every sandbox resolves that one pointer: the image bakes
`/mnt/libs/current/...` into a `.pth` file and into `R_LIBS_SITE`
(`images/sandbox-base/Dockerfile:412,433-434`), and the harness injects the same
constant (`harness/src/sandbox/mount-plan.ts:124`). The provisioner refuses to
move the pointer while any sandbox lease is active
(`images/sandbox-provisioner/provision.py:1050-1056`). Thus one live analysis
freezes the library set of every other analysis.

The mechanics under the pointer already support many farms. The pool is
content-addressed and write-once. Each farm carries its own completeness markers
(`packages.txt`, `meta.json`, `lock.json`). The publish swap is atomic per farm.
Only the selector is single.

Two facts constrain the design:

1. A farm link bakes the absolute target `/mnt/libs/store/...`, thus the store
   root must stay mounted at `/mnt/libs` in every container that resolves a farm.
2. The numba cache keys hold source paths under `/mnt/libs/current/...`
   (`provision.py:860-866`, measured). Thus the per-sandbox farm must appear at
   exactly that path, or every warm cache misses.

## Goals / Non-Goals

**Goals:**

- Two sandboxes of two analyses resolve two different farms at the same time.
- The container path `/mnt/libs/current` keeps its meaning, thus the image does
  not change.
- Acquisition runs in parallel. Shared metadata stays consistent under a narrow
  mutex.
- The dependency closure of the pool is machine-readable on the host.

**Non-Goals:**

- Farm composition. The embedder owns it. The harness only mounts what the
  provider names. The companion CLI change `per-analysis-farms` covers it.
- The flight dedup of concurrent `store add` requests. That orchestration is
  embedder work, in the companion change.
- A change to the sandbox security posture. No network, uid 1000, read-only
  store — all unchanged.

## Decisions

### D1 — The farm arrives as a nested bind, not as a pointer

Each sandbox gets two read-only binds: the store root at `/mnt/libs`, and the
analysis farm at `/mnt/libs/current`. The child bind shadows the mount point
inside the parent bind. The farm links (`/mnt/libs/store/...`) resolve through
the parent bind. The baked env resolves through the child bind.

Alternative — mount the farm at a per-analysis path and point the env at it:
rejected, because it obliges an image change and it invalidates every numba
cache key (fact 2 in Context).

Alternative — keep the pointer and serialize analyses: rejected, that is the
defect.

### D2 — The embedder supplies the farm through a provider seam

`CreateSandboxConfig` gains a provider function: analysis id in, farm location
out, resolved each time a sandbox starts. On Docker the location is a host
path. On Kubernetes it is a subPath under the store PVC. The harness composes
the bind or the volume mount from it and never learns the naming rule.

The provider returns nothing when the analysis has no farm yet. The harness then
refuses the sandbox with a named state, the same shape as the incomplete-store
refusal. The embedder makes the farm before it retries — that ordering is
embedder work.

Alternative — the harness derives `farms/<analysisId>` itself: rejected. The
naming rule is a store-layout decision, and the store layout belongs to the
embedder side of the seam. A baked rule would also block a shared-farm layout
later.

### D3 — The usability gate follows the farm

`libStoreUsable` today follows `current` and requires `packages.txt` and
`meta.json` inside it (`docker-client.ts:126-135`). It re-targets to the farm
location the provider names. The markers already exist per farm, so the gate
logic keeps its shape. A store-level `current` link, when present in an old
store, is ignored.

### D4 — The lock narrows to three roles

Today one exclusive flock covers a whole mutating run (`provision.py:996-1010`),
so a second run refuses at once. The new shape:

- **Acquisition runs share.** The pool writes are race-safe by content
  addressing. Two runs that produce the same store directory converge on one
  name.
- **The commit takes a short mutex.** The `deps.json` append and the inventory
  rederive are read-modify-write on shared files. The mutex covers only that
  commit, at the end of a run.
- **Reclaim is exclusive.** A run that wrote pool directories but has not
  committed yet holds unreferenced directories — exactly what reclaim deletes.
  Thus reclaim waits for zero acquisition runs and blocks new ones, a
  reader-writer discipline on the same lock file.

Crash story: a crash before the commit leaves orphan pool directories and no
graph entry. Reclaim eats them later. No half-written metadata is possible,
because the mutex serializes the metadata writes.

### D5 — The graph ships resolved edges in `deps.json`

One file at the store root. A node is a store-directory name
(`scanpy-1.10.3-4f0a9c21`), with its track, its import names, its entry points,
and the R inner-directory name. An edge list names other nodes — exact, no
version range. All constraint solving stays where it already happens: pip and
pak at build time.

The emitter runs inside the provisioner image, once after the CI bulk build and
once after each acquisition run. Python edges come from `importlib.metadata`
with markers evaluated in-image — the build environment is the sandbox
environment, so each marker evaluates to its runtime truth. R edges come from
the two runtime `DESCRIPTION` fields `Depends` and `Imports`, read with
`read.dcf`.
Edges into image-owned base packages are dropped against a fixed list. CI gates:
every remaining edge lands inside the node set.

`LinkingTo` gives no edge. `LinkingTo` is a build-time field, and it names the
headers of a source build. R never loads such a package at run time, and pak
omits it from a binary install. Thus the pool holds no store directory for such
a name, and an edge to it would always dangle.

Alternative — parse `METADATA` and `DESCRIPTION` on the host at compose time:
rejected. It duplicates marker evaluation outside the environment of record, and
it re-reads hundreds of files on every compose.

### D6 — Leases keep one job

The flip refusal dies with the flip. A lease still records "a sandbox holds the
store mounted," and one guard remains: a farm removal refuses while a lease
names a sandbox of that farm. Extension of a live farm needs no guard — new
links touch no old link, and the bind reflects them.

### D7 — The provisioner warms through a run-supplied bind

`warm()` must import through `/mnt/libs/current` (fact 2). With no host
pointer, the invoker of the provisioner container adds a bind for the run: the
target farm at `/mnt/libs/current`. Inside the container nothing changes.

Alternative — write a temporary `current` symlink during the run: rejected, it
reintroduces the shared mutable pointer this change removes, visible to every
concurrent reader of the store root.

## Risks / Trade-offs

- [Nested bind ordering] Docker and podman must mount `/mnt/libs/current` after
  `/mnt/libs`. Both order binds by destination depth, but this is engine
  behavior, not API contract. → A backend test pins it: make sure that a
  container with both binds resolves a farm file and a store file.
- [Old store, new harness] A store that still carries `current` must not
  confuse the gate. → D3 ignores the link. A migration note in the companion
  CLI change removes it.
- [Extras under-linking] The no-extra marker evaluation drops the optional-extra
  edges of Python. A composed farm can miss an optional dependency. → The
  import-failure loop in the embedder extends the farm on demand. The CI edge
  gate keeps the mandatory closure complete.
- [Parallel R compiles] Shared acquisition runs can each compile R sources and
  exhaust memory. → The embedder caps concurrent flights. The harness-side lock
  does not bound work, only correctness.

## Migration Plan

1. Land the provisioner changes: lock narrowing, emitter, no flip. The pointer
   file stays inert on old stores.
2. Land the harness seam and the nested bind behind the provider: an embedder
   that supplies no provider keeps the old single-mount behavior for one
   release.
3. The companion CLI change wires the provider, composes farms, and deletes the
   pointer from existing stores.

Rollback: the pointer file still exists on disk until the CLI migration removes
it, thus a rollback to the previous harness resolves `current` as before.

## Open Questions

(none — the six decisions above were settled in conversation with the user)
