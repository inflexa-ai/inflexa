# The decision record of the package-store rebuild

This document is the shared-understanding record of the grill session of
2026-08-19. The sources are `author_vision.md`, the four harvest reports in
`spike_harvest/`, and `grill_round3.md`. The status is: **awaiting the
confirmation of the author**. No spec work starts before that confirmation.

The rebuild replaces PR #291 with fresh work on `feat/local-package-store`,
from the current main. The spike stays a read-only reference. Proven fragments
copy over. Commits do not cherry-pick.

## The goals

- Minimize the setup time and the time-to-analysis of a user.
- Let a user install custom packages and use them in an analysis.
- Design for the CLI experience. The harness must not regress for the managed
  service.

## The scope

In scope:

- The two-image build, the OCI bundle, and the content-addressed store with
  per-analysis farms, rebuilt from the spike evidence.
- R acquisition, together with the Python path (decision 4).
- The provisioner security posture (decision 9).
- The per-analysis warm cache, the spec that the spike left at 0 of 17 tasks.

Out of scope, recorded as named open decisions in the spec:

- The managed-service store delivery. The tarball replacement stays `BLOCKED`.
- The Kubernetes ReadWriteOnce node pin.

## The decisions

### 1. The harness boundary (Q1, Q11)

The harness never infers its host. The embedder declares facts in config, and
the harness keys on the facts. One declared field states that the image owns
the toolchain. That field gates the `PATH` set, `NODE_PATH`, and the
orient-core prompt text. An absent field keeps the old behavior, thus the
managed service adopts the feature with config values only, and its current
images keep their behavior. `farmSource` stays a necessary field, and the
`fixed` kind serves the managed shape. The union keeps the two kinds only. A
`none` kind joins only when a real embedder wants a no-store mode. The
`link_packages` prompt layer stays gated on the bound seam.

### 2. The managed service (Q3)

The rebuild does not solve the managed delivery. The harness seams stay
delivery-neutral. Later work accommodates the managed side.

### 3. The manifest and the locks (Q4, Q13)

The manifest is the intent layer: name, version constraint, and a mandatory
`reason` per entry, with a JSON schema. The build workflow resolves per arch,
with hashes, and commits the per-arch lock files back to the repository. A
later run reuses each lock entry whose manifest constraint still matches, and
it re-resolves an entry that the manifest changed. The model is `npm install`
with a committed lock, not `npm ci` and not hand-written hashes.

### 4. The R tracks (Q2, Q12)

Acquisition covers CRAN and Bioconductor, through the one pak path. The
`github` and `git` tracks stay catalog-only manifest entries. R acquisition
ships together with the Python acquisition, in the same cut. A sequence would
shape the shared code around Python and force a rewrite for the R quirks.

### 5. The farm contract (Q5, Q14)

One schema-versioned `inflexa.lock` is the whole metadata surface of a farm.
It holds the arch, the tracks, each package with version and hash, the
embedded pak lock, and the warm record. The harness gate and the inventory
read it. `lock.json`, `meta.json`, `packages.txt`, and the per-track fragments
die. The farm surface is: the link trees, `inflexa.lock`, and the caches.

### 6. Warming (Q6, Q15)

One warm script per package, named by the manifest entry as `warm: <path>`.
The global workload script and the module list die. The preparation run
executes the script of each linked package and records the cache entries per
package. Accepted consequences: fixtures duplicate across scripts, and an
acquired package warms only through the per-analysis runtime cache. The
acquisition-time warm stays dead, because a numba entry keys on a call
signature. The per-analysis warm cache is part of the rebuild.

### 7. The conversation flow (Q7, Q16, Q16b)

After the plan, the conversation writes the package list and marks the missing
packages. The agent asks per package, through the existing run-inflexa
approval flow (`store add` keeps `kind: "approval"`). A refusal returns to the
agent as guidance for a replacement. The prompt gains the swap invitation
("do you want a different package instead?"). The chat install that works
today must keep working.

### 8. Setup and transfers (Q8)

The transfers start at the start of setup, after one consent. Three
independent detached children move the runtime image, the provisioner image,
and the catalog, each with its own progress row. The TUI shows the three rows
until each is complete, and then the rows disappear. A re-download command
exists for the images and for the catalog. A superseded image is removed only
after the new pull verifies, and the TUI says so. The catalog merge stays
add-only, and `--update` replaces the graph. During a transfer the chat and
the planner stay usable, and only a sandbox-making action waits, with a
notification.

### 9. Security (Q9)

The provisioner gets an egress allowlist for the pinned index hosts. droast
covers both Dockerfiles. The privilege asymmetry of the provisioner is
recorded in the spec.

### 10. The dependency graph (Q10)

`emit-deps.py` and `deps.json` stay as designed: `packaging` evaluates the
markers, `LinkingTo` gives no edge, and a dangling edge stops the build. The
Syft/SBOM alternative is a recorded note, not a task.

### 11. The provisioner surface (Q17, Q17b, UserQ1)

The entrypoint gains subcommands: `build`, `acquire`, `prepare`, `verify`,
`repair`, `reclaim`, `remove-farm`. One mode each, and an impossible
combination is impossible by structure. The spec names one caller per
subcommand. `repair` runs as an internal step at the start of each run, not as
a flag. `verify` gets a caller in the spec, or it dies. The lease drops whole:
the modes, the files, and the removal guard. The delete-flow gate of the TUI
is the one guard, and the rebuild hardens its stale-`running`-row weakness.

### 12. The install boundary (Q18, UserQ2)

The provisioner installs everything that lands in the store: the Python and R
tracks. The image owns the interpreters, conda at `/opt/conda`, and Node at
`/opt/node`, because a conda prefix does not relocate and cannot join a
content-addressed store.

### 13. Validation (Q19, Q19b, Q19c, UserQ3)

CI runs the checks inside the sandbox image directly, with no CLI install.
The acquisition flight ends with a load check of the acquired package, inside
the sandbox image, BEFORE the commit to `deps.json` and before any link. Thus
a failed check leaves no advertised state: the flight reports the failure, a
retry is clean, and `store reclaim` frees the orphaned bytes. That ordering is
the recovery. Cache validation stays a CI gate.

### 14. The names (Q20, UserQ4)

The one term is **package store**. The rename table in `grill_round3.md` is
accepted: the workflows, the manifest path, the scripts, and the dead files.
The config keys follow in the spec table.

### 15. Ecosystem selection (Q23)

The CLI surface is flags: `inflexa store add <package> [--version <v>]
[--lang python|r]`. A prefix syntax such as `r::limma` never reaches the
surface. It stays an encapsulated internal format, where a tool needs one.
Without `--lang`, the flight searches both ecosystems. When both hold the
name, the flow stops and asks the user. The same ask applies at link time,
when both tracks of the pool hold the name. A silent Python-first win is a
fault.

### 16. Acquisition batching (Q23d)

The asks stay one per package, as decision 7 states. An approved package
joins a host-side pending set. The flight starts when the asks of the turn
finish, at the end of the agent turn or on an explicit flush. Then one
one-shot provisioner run resolves the whole approved set, thus the shared
dependencies resolve once. A spec that cannot resolve drops out with its own
refusal, and the rest retries as one batch. No long-lived provisioner exists,
because a daemon buys only the container start time. The CLI surface stays
one package per `store add` call — bulk is queue behavior, not syntax.

The flush grill (round 13) confirmed the trigger. An approved add only
enqueues, thus the ask tool returns fast and no ask comes after the turn.
A mid-turn grace timer is rejected, because the formulation time of the
agent has no bound and a timer would split one batch. The set persists in
the primary database, and a crash loses no entry. The queue drains at the
next turn end or at a terminal add — no boot drain exists. A flush can
claim the entries of another live turn, and that split is accepted.

## The vocabulary of the rebuild

- **package store** — the host directory with the pool, the farms, and the
  graph. Replaces "lib store" everywhere.
- **pool** (`store/`) — the content-addressed directories, one per installed
  distribution, write-once.
- **farm** — the per-analysis symlink tree. Made empty with its analysis,
  extended additively, dead with its analysis.
- **catalog** — the published default package set that the download delivers.
- **template** (`farms/catalog`) — the delivered farm that holds the shared
  prepared caches.
- **acquisition** — an install into the pool, by the provisioner, with no farm
  work.
- **flight** — one shared in-progress acquisition for one normalized spec.
- **composition** — the host-side linking of a farm from the pool, through the
  graph.
- **graph** (`deps.json`) — the resolved dependency edges at the store root.
- **provisioner** — the network-enabled container that writes the pool and
  the farms.
- **preparation run** — the run that executes the warm scripts against the
  catalog and records the cache entries.
- **lease** — dropped. The term leaves the model.

The per-subsystem `CONTEXT.md` files update when the implementation lands,
not before, so the glossary never runs ahead of the code.

## Open items that the spec must carry

- The managed store delivery (`BLOCKED`) and the K8s node pin.
- The caller of `verify`, or its removal.
- The hardening of the delete-flow gate (stale `running` rows,
  `spike:cli/src/tui/commands.tsx:128-129`).

## The audit refinements (rounds 7 and 8)

The two OpenSpec changes carry the later decisions, and the grill documents
`grill_round6.md` and `grill_round8.md` carry their context:

- The both-hit stop splits by route: an interactive command asks, and the
  seam refuses with agent guidance.
- `store reclaim` is `approval`. The command noun stays `inflexa sandbox`.
- The image downloads are detached transfers everywhere, and no foreground
  pull exists. "Variant" leaves the vocabulary — the two images are roles.
- The pending set flushes at the end of the agent turn, or on an explicit
  flush. Round 13 rejected the earlier short-grace idea — refer to decision 16.
- A failed transfer row stays visible, with a push-to-retry and a palette
  entry. The answers-file form is `sandbox: true`.
- The per-analysis cache design is confirmed: seed at farm creation, a
  read-write mount at `/mnt/libs/cache`, and the `/tmp` fallback.
- From the reversal-regression pass (rounds 9 and 10): the new farm
  container path is `/mnt/libs/farm`, and the legacy branch keeps
  `/mnt/libs/current` for the old baked images. The provisioner image
  reference derives from `harness.sandboxImage`, with no second config
  key. A farm publishes by a crash-atomic staging swap, `inflexa.lock`
  writes last, and hoisted console scripts link relatively.

## The next step

On confirmation of this record: OpenSpec changes, harness first, then the CLI,
per the boundary rule. The build side lives in the harness spec tree
(`lib-store-build` today, renamed per decision 14).
