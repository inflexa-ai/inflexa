# The local package store — the working record

This file consolidates the working papers of the `feat/local-package-store`
rebuild: the author vision, the decision record of the grill sessions, the
harvest of the spike (PR #291), the prior-art research, and the CI
postmortems. The spec trees hold the requirements. This file holds the
history and the why.

---

## Part 1 — The author vision

The goals: minimize the setup time and the time-to-analysis of a user, and
let a user install custom packages for an analysis. The design serves the
CLI experience first. The harness stays host-agnostic, and it must not
regress for the managed service.

The old state: two baked image flavours, Python (10 GB+) and Python+R
(20 GB+). The pull blocked the user, and a baked image could not extend.
The spike's `current` pointer then limited the host to one active analysis
at a time, which the vision rejects outright.

The proposed shape: two images and one OCI artifact. The provisioner image
holds the toolchain and the network, and it writes the store. The sandbox
image holds the runtimes only, and it bakes no library. The OCI artifact
carries the compiled packages, per arch, and the sandbox image validates it.

The vision also set these directions:

- The manifest is redesigned: fixed versions with hashes ride a committed
  lock, in the model of `package-lock.json` and `uv.lock`.
- A farm carries one standard lock file, not a pile of ad-hoc records.
- Warming is part of the build, through per-package warm scripts, because a
  cold scanpy or matplotlib costs 20-30 minutes. Each analysis gets its own
  writable cache, seeded from the shipped one.
- A new farm starts empty. The planner names the packages, the agent asks
  the user per package, and a run can link but never install.
- The dependency graph exists because a link must carry its closure.
- Setup starts the three downloads first, detached, with progress in the
  TUI. Work that needs them waits with a notice. Completed rows disappear.
- Image re-download replaces old images with notice. A catalog re-download
  merges and removes nothing.

---

## Part 2 — The decision record

The grill of 2026-08-19 settled the rebuild against the spike evidence. The
rebuild replaced PR #291 with fresh work from main. The spike stayed a
read-only reference: proven fragments copied over, commits did not
cherry-pick.

### The core decisions (1-16)

1. **The harness boundary.** The harness never infers its host. The embedder
   declares facts in config. `toolchainSource` states that the image owns
   the toolchain, and it gates `PATH`, `NODE_PATH`, and the orient prompt.
   `farmSource` is a required field, and the `fixed` kind serves the
   managed shape.
2. **The managed service.** The rebuild does not solve the managed delivery.
   The seams stay delivery-neutral. (Superseded later: issue #69 of
   platform-charts carries the managed delivery through the CLI fetcher.)
3. **The manifest and the locks.** The manifest is the intent layer: name,
   optional constraint, and a mandatory `reason`, under a JSON schema. The
   build resolves per arch with hashes and commits the lock back — the
   `npm install` model with a committed lock.
4. **The R tracks.** Acquisition covers CRAN and Bioconductor through pak.
   The `github` and `git` tracks stay catalog-only. R ships together with
   Python, in one cut.
5. **The farm contract.** One schema-versioned `inflexa.lock` is the whole
   metadata surface of a farm: the arch, the tracks, each package with
   version and hash, the embedded pak lock, and the warm record.
   `lock.json`, `meta.json`, `packages.txt`, and the fragments die.
6. **Warming.** One warm script per package, named by the manifest entry.
   The preparation run executes each script and records the cache entries
   per package. An acquired package warms only through the per-analysis
   runtime cache, because a numba entry keys on a call signature.
7. **The conversation flow.** After the plan, the conversation marks the
   missing packages and asks per package through the `run_inflexa` approval
   flow. A refusal returns as guidance, with a swap invitation.
8. **Setup and transfers.** Three independent detached children move the
   runtime image, the provisioner image, and the catalog, after one
   consent, each with its own progress row. Chat and the planner stay
   usable, and only a sandbox-making action waits.
9. **Security.** The provisioner gets an egress allowlist for the pinned
   hosts. droast covers both Dockerfiles. The privilege asymmetry is
   recorded in the spec.
10. **The dependency graph.** `emit_deps.py` and `deps.json` stay:
    `packaging` evaluates the markers, `LinkingTo` gives no edge, and a
    dangling edge stops the build.
11. **The provisioner surface.** Subcommands, one mode each: `build`,
    `acquire`, `prepare`, `reclaim`, `remove-farm`. `repair` runs as an
    internal step. The lease dropped whole.
12. **The install boundary.** The provisioner installs everything that
    lands in the store. The image owns the interpreters, conda at
    `/opt/conda`, and Node at `/opt/node`, because a conda prefix does not
    relocate.
13. **Validation.** CI runs the checks inside the sandbox image, with no
    CLI install. An acquisition ends with a load check inside the sandbox
    image BEFORE the commit and before any link. A failed check leaves no
    advertised state.
14. **The names.** The one term is **package store**. "lib store" dies
    everywhere: the workflows, the manifest path, the scripts.
15. **Ecosystem selection.** The surface is flags: `store add <pkg>
    [--version] [--lang python|r]`. A prefix syntax never reaches the
    surface. Without `--lang` the flight searches both ecosystems, and a
    both-hit stops with an ask. A silent Python-first win is a fault.
16. **Acquisition batching.** An approved package joins a host-side pending
    set. One one-shot provisioner run takes the whole claimed set, thus
    shared dependencies resolve once. No daemon exists. A spec that cannot
    resolve drops out with its own refusal.

### The vocabulary

- **package store** — the host directory with the pool, the farms, and the
  graph. Replaces "lib store".
- **pool** (`store/`) — the content-addressed directories, one per
  installed distribution, write-once.
- **farm** — the per-analysis symlink tree. Made empty with its analysis,
  extended additively, dead with its analysis.
- **catalog** — the published default package set that the download
  delivers. **template** (`farms/catalog`) — the delivered farm with the
  shared prepared caches.
- **acquisition** — an install into the pool, with no farm work.
  **flight** — one shared in-progress acquisition for one normalized spec.
- **composition** — the host-side linking of a farm from the pool, through
  the **graph** (`deps.json`).
- **provisioner** — the network-enabled container that writes the pool and
  the farms. **preparation run** — the run that executes the warm scripts.
- **lease** — dropped. The term left the model.

### The audit refinements (rounds 7-8)

- The both-hit stop splits by route: a command asks, the seam refuses with
  agent guidance.
- `store reclaim` is `approval`. The image downloads are detached
  everywhere, and no foreground pull exists. "Variant" left the vocabulary:
  the two images are roles, the runtime image and the provisioner image.
- A failed transfer row stays visible, with a push-to-retry and a palette
  entry. The answers-file form is `sandbox: true`, a pure consent.
- The per-analysis cache: seed at farm creation, a read-write mount at
  `/mnt/libs/cache`, and a `/tmp` fallback. The cache is per analysis,
  because a loaded numba entry is machine code, and a shared writable home
  would let one analysis plant code for another.
- From the reversal-regression pass (rounds 9-10): the new farm container
  path is `/mnt/libs/farm`, and the legacy branch keeps `/mnt/libs/current`
  for the old baked images. A farm publishes by a crash-atomic staging
  swap, `inflexa.lock` writes last, and hoisted console scripts link
  relatively.

### The first-live-run decisions (17-23)

The first end-to-end chat run surfaced three faults: the agent asked for
held packages, the sidebar mixed flights into TRANSFERS, and the agent
claimed an ordering that no mechanism gives.

17. The conversation agent and the planner get a POOL-scope inventory from
    `deps.json`. The sandbox agents keep the farm view.
18. Every inventory answer carries `name==version`. The targeted path also
    carries the store directory and the full hash.
19. No chat-time link and no link approval: a link writes no new content.
20. The pool-miss refusal at launch IS the ordering gate. The remedy
    classifies each miss: in flight, failed with the recorded reason, or
    unknown with the store-add ask.
21. The sidebar splits into TRANSFERS (machine state) and PACKAGES
    (analysis work), with a summary line.
22. Each transfer row meters its own progress, with a real total from the
    registry manifest. A row that moves is never read as stuck.
23. A failed flight opens a dialog: the spec, the phase, the whole recorded
    reason, the store directory, and the hash. Copy, retry, delete.

### The spiral postmortem decisions (24-28)

The second live run spiraled on "add polars, then launch". Five defects
stacked.

24. The 10-second flush gate: the flight starts at the turn end, an
    explicit flush, or 10 seconds after the pending set becomes non-empty.
    The gate anchors and does not slide.
25. `--lang` joined the safe flags, and a bare `store link` resolves the
    analysis from the anchor. The link now truly runs without an ask.
26. The reclaim reference set gains the graph: farm links plus graph nodes.
    Before this, a reclaim deleted fresh local acquisitions and cut live
    edges.
27. A version-collision refusal names the dependents that pull each pin, on
    every surface. The live run guessed the culprit wrong and lost five
    turns.
28. A pass that cannot answer says why: an unreadable graph reports
    `unavailable` with the graph reason, never a per-package absence and
    never a bare UNKNOWN.

### The add-time guards (29-30)

A live probe proved that one stale farm refused every extension, because a
later add moved a held graph edge.

29. The first resolution of a store directory is durable. The commit skips
    a held node, thus no add can invalidate a farm. No repair command
    exists — the cause left.
30. The acquire resolves under the pins of the pool, as constraints, with a
    drop on a true conflict — the committed-lock pattern. A second pin
    appears only when the ranges force it.

### The catalog-build postmortem decisions (31-35)

No catalog build was clean before 2026-08-26. Five faults hid behind
best-effort warnings. The rule: a silent degradation of the farm is a
defect.

31. The egress resolution pinned into `/etc/hosts` against GitHub rotation.
    (Reversed by 37.)
32. A github build refuses without `GITHUB_PAT`, early and loud. An
    unexported variable had fed an empty token, and the build ran at 60
    calls per hour.
33. The github track installs through pak, because `remotes` cannot convert
    a pak-installed dependency.
34. A failed install keeps the held package: the farm carries over a store
    directory that the previous farm advertised, when the pool holds it.
    One bad round must not remove good packages.
35. The build machine needs a memory floor. Three parallel R source builds
    killed a 5.7 GiB machine. The local machine rose to 12 GiB, and
    `r_ncpus` stays the throttle of last resort.

### The wall postmortem decisions (36-38)

The first CI catalog build died at the 240-minute budget with zero CRAN
packages: six workers against a 300-second timeout for 3.5 hours.

36. A p3m.dev binary GET redirects on a cache miss, with a 307 to
    `rspm-sync.rstudio.com`. A HEAD answers clean, thus the probe lied.
    Both allowlists carry the pair, and the canary follows the redirect.
37. Decision 31 reversed: the pin froze a 60-second rotating pool. The wall
    now follows DNS live — dnsmasq feeds each answer into an nft set before
    the answer returns. nftables replaced ipset, because `ip_set` does not
    load in a container.
38. The wall rejects, and a canary proves both sides. The last rule is
    REJECT, thus a blocked connect fails in milliseconds and names its
    host. A fatal canary fetches one pinned binary whole and proves a fast
    refusal of an off-list host, before the build.

### The image-hygiene decisions (round 12, 2026-08-20)

- The seed file became `inflexa-seed-caches.sh` at `/usr/local/lib/`,
  because it is a sourced library and not a command.
- The four inline Dockerfile programs moved to
  `images/sandbox-base/scripts/`, and the Dockerfile comments obey STE.
- The version bumps: uv 0.12.5 in both Dockerfiles, ruff 0.16.3,
  tailwindcss v4.3.3, micromamba 2.9.0, Node.js 24. The rocker 4.6.1 bump
  waits for its own change, because it moves the pinned CRAN snapshot.
- The committed lock stays the pin layer. The manifest keeps the optional
  constraint. Dependabot reads the FROM lines only, and the ENV pins stay
  manual — `manifest.yaml` records the gap.

---

## Part 3 — The grill reference material

### The provisioner modes (round 3)

`build`, `acquire`, `prepare`, `reclaim`, and `remove-farm` kept a caller
each. `repair` became an internal step at the start of each run. `verify`
had no caller and died. The lease pair had no writer — the guard guarded
nothing — and died whole.

### The conda boundary (round 3)

conda is the bioconda command-line track, not the Python track. A conda
prefix is one directory tree with absolute paths baked at install time,
thus it cannot divide into content-addressed directories. The image owns it
at `/opt/conda`: the tools change rarely, and they ride the image scan. The
bundle-blob alternative was rejected — 1-2 GB in every artifact, outside
the scan.

### The farm source shape (rounds 4-5)

`FarmSource` is a required union of two kinds. `fixed` names one farm for
every analysis — the managed shape. `per-analysis` supplies a resolver of
the embedder. The spike tried an optional provider first, and `undefined`
carried two meanings. A compatibility kind then read a `current` pointer
that nothing wrote. The final rule: a value must not carry two meanings,
and a code path must have a producer.

### The batching shapes (round 5)

Three shapes were weighed: one flight per package (N resolves), a
long-lived provisioner daemon (buys only the container start, costs crash
recovery and a long-lived writer), and the host-side pending set. The
pending set won: one one-shot run per batch, the consent model unchanged,
and a failing spec drops out alone.

### The audit context (round 6)

- The host commits phase two: the acquire run writes the staged nodes as
  data, and the flight appends under the existing metadata lock. A `commit`
  subcommand was rejected — one more container start for nothing.
- The link-time both-hit rule is CLI code, thus the CLI change carries it.
- The `inflexa.lock` draft: schema, arch, tracks, packages with
  `store_dir` + full hash + `requested`, the embedded pak lock, the warm
  record, and collisions.
- The coverage guard diffs the loadable set against the last published
  artifact per arch: a load regression fails the build, an intentional
  removal reports and passes, an arm64 gap informs.
- The egress classes per track: the Python index, the pak repositories, the
  GitHub hosts (catalog only), and `git.bioconductor.org` (catalog only).
  An acquisition needs only the first two.
- The media types:
  `application/vnd.inflexa.package-store.track.v1.tar+zstd`, `.base.v1`,
  and the manifest type. The content address: sha256 over the sorted tree
  (paths, bytes, executable bit, symlink targets), markers and derived
  caches excluded, first 16 hex characters in the directory name.
- "Names no remedy": the harness error names the missing packages but no
  host command, because a managed deployment holds no `inflexa` binary.
  The CLI appends its own remedy line.

### The cache and transfer design (round 8)

The per-analysis cache, end to end:

- The build warms the catalog and records the entries.
- Farm creation copies the prepared caches per analysis.
- The harness mounts the cache read-write at `/mnt/libs/cache`, and
  `NUMBA_CACHE_DIR` and `MPLCONFIGDIR` point into it.
- A missing cache degrades to a `/tmp` copy.

The cache is per analysis and never shared. A loaded `.nbc` entry is
machine code.

### The verification findings (round 11)

- `validate_plan` the TOOL left in July — the shared validator carries the
  behavior, and the spec wording amended at sync.
- `install-build-toolchain.sh` moved into `images/sandbox-provisioner/`,
  its one consumer.
- The spike's stdlib-only provisioner unit tests (2469 lines) were ported
  in adapted form.
- The workflows and the rig had never run — static validation only. The
  cheap real check: build the provisioner locally and run the check script
  against PyPI and CRAN. (The later CI postmortems proved the point.)
- The acquisition egress classes needed a CLI-side spec line, or the flight
  could launch the provisioner with open egress.

---

## Part 4 — The spike harvest (PR #291)

The spike ran 105 commits, 2026-08-03 to 2026-08-18. The full harvest holds
a dated timeline; this section keeps the shape, the reversals, and the open
threads.

### The arc

The prototype split the sandbox into two roles and made the store
content-addressed with symlink farms. The R track unified onto one pak
lock. The provisioner gained hash-proof installs (`--generate-hashes`,
`--require-hashes`) against a pinned index. The store gained a lock, a
`current` pointer, leases, and reclamation — and then lost the pointer and
the leases. The publish went to GHCR as an OCI artifact with immutable
version tags. The download became a detached child with a database row and
a receipt written last. The farm became per-analysis, the graph
(`deps.json`) became the link-time authority, and the farm-extension seam
(`link_packages`) landed in the always-on substrate. A farm ended empty at
creation, with the planner naming packages per step.

### The reversals worth remembering

The harvest records 29. The load-bearing ones:

- **The active-farm pointer.** `current`, `flip_current`, the lease guard,
  and `--force-repoint` all died: one live sandbox froze the library set of
  every other analysis. The farm became a per-sandbox bind.
- **`inflexa store use`** died with the pointer — no active farm remained
  to switch.
- **The store opt-in and the configured root** died: the store root became
  a CLI-owned constant, because no image bakes a library any more.
- **The managed tarballs** were kept "until Phase 5", then retired — the
  managed delivery decoupled.
- **`LinkingTo`** entered the edge set under "over-inclusion is harmless",
  and left when the gate made each edge a requirement: 4 of 5 dangling
  edges came from it.
- **The hand-rolled marker parser** left for `packaging` — its recorded
  reason was false, and a wrong parse is silent.
- **The default farm content, two times**: closure walk, then template
  copy, then nothing — a farm starts empty and the plan names its packages.
- **The acquisition warm** died: a numba entry keys on a call signature,
  and an import gives none.
- **The R store layout** nested the package (`<dir>/<Name>/`), because
  Rfast rebuilds its own path. The R check loads namespaces, because an
  attach of 753 packages tripped `conflicted`.
- **The farm publish** became a crash-atomic staging swap with relative
  hoisted links, after an absolute-link dangle.
- **The shared top-level name rule**: two distributions may share a
  namespace directory; only two versions of one distribution refuse.

### The open threads the spike left

The branch push trigger (a sentinel file), the egress firewall duty, the
provisional `timeout-minutes`, the Kubernetes ReadWriteOnce node pin, the
per-analysis warm cache (specified, 0 of 17 tasks), and the R acquisition
gap. The rebuild closed each except the node pin, which stays a named open
decision.

### The build side, in short

The spike replaced three baked images with sandbox-base plus
sandbox-provisioner, one manifest base digest, and an ORAS publish with
layer-digest comparison on the immutable tag. The store layout: the pool
with the two markers, the per-analysis farms, and `deps.json` with the
`by_name` newest-first ordering. A dangling edge gates the build, and
`base-packages.json` is the image-owned exclusion list. The acceptance
pulled the published artifact and mounted the store read-only into the
published image. It proved that each advertised module resolves from the
content store.

### The cli side, in short

The farm lifecycle: made empty with the analysis, healed at the first
sandbox action, extended by the user (`store add --analysis`,
`store link`), by the plan (the pre-launch link pass), and by the agent
(`link_packages`), and removed with the analysis. Composition plans against
an overlay and writes second — a version collision refuses the whole batch.
Concurrency rides the instance-lock family: one downloader, one
reclamation, one metadata writer, capped flights, per-farm mutexes. The
detached download reports through a database row, because the in-process
bus cannot carry a child's events. The gate holds only a sandbox-making
action, and the filesystem decides usability: a receipt plus a pool
inventory.

### The harness side, in short

The seams: `FarmSource` (required), `ResolveAnalysisFarm` with an
`unavailable` refusal, and `ExtendAnalysisFarm` behind `link_packages` and
the pre-launch link pass. The mount contract: the store read-only at
`/mnt/libs`, the farm as a second nested read-only bind, the cache
read-write. The resolver env moved to the image paths (`/opt/conda/bin`,
`/opt/node/node_modules`), with the farm `bin` LAST on `PATH`, thus a farm
script never shadows an image tool. The managed exposure was audited item
by item: with the store config absent, the provider never runs and the
behavior does not change. No agent-facing text uses the word "farm" — the
term stays host-side.

---

## Part 5 — The research conclusions

### The manifest (multi-ecosystem package manifests)

The verdict: keep the custom manifest as the intent layer, and harden it.
No standard expresses the whole set in one document: R from an arbitrary
git commit, PyPI, bioconda tools, npm, per-arch splits, structured
rationale, and the advertisement distinction. The two-layer
manifest-to-lock pattern is universal inside one ecosystem, and no
cross-ecosystem standard exists — the file fills a real gap.

- Pixi came closest, and it fails on one load-bearing fact: it cannot
  install an R package from an arbitrary GitHub tag or a
  `git.bioconductor.org` commit without a conda recipe. Only pak, renv,
  and remotes express that. Nix fails on relocation, R lag, and a
  wholesale rewrite. conda `environment.yml` has no git field at all.
- The adopted fixes: a JSON schema with a CI gate, structured `reason`
  fields in place of comments, and the manifest kept as intent over the
  committed per-arch locks. An SBOM (CycloneDX with purl identifiers) is
  an output artifact to emit later, never the input.
- The revisit triggers: pixi gains recipe-free R-git support, or the
  special cases proliferate — then split per ecosystem with a thin
  orchestration file.

### The dependency graph (prior art)

The verdict: a competent re-implementation of the Nix, Guix, and Spack
architecture — the content-addressed pool with symlink projection is
Spack's hash-suffixed installs plus `spack view`, and GNU Stow coined
"symlink farm". The genuinely bespoke and justified parts: one mixed
Python+R store with per-track disambiguation, the fail-loud gate, the
incremental append under a commit mutex, and the sub-second image-free
extension.

The reinventions the research named, and their fate:

- The hand-rolled PEP 508 parser — replaced with `packaging`, exactly as
  the research recommended (decision, and spike reversal 21).
- The `LinkingTo` discrepancy — the research caught that the shipped code
  still read it, against the stated fix. The rebuild dropped it (decision
  10).
- Graph emission as an SBOM (Syft to CycloneDX, an adapter over purl) —
  a recorded note, not a task (decision 10).

The pitfalls list that mature systems documented, kept as a watch list:
`.pth` files and site customization under symlinks, `__pycache__`
collisions, PEP 420 namespace packages, compiled-extension RPATHs,
console-script shebangs, R's install-time library binding, the symlink
against hardlink trade, the one-version-per-farm diamond rule, and Windows
junctions. The farm answers the diamond rule by design: one closed
resolved set per farm, and two versions mean two farms.

---

## Part 6 — The CI postmortems

### The three failed store-pipeline runs (2026-08-26/27)

Three runs failed on three single causes, each one layer deeper. The build
core was healthy from run B onward: 539 binaries per arch with zero
download failures, 309 builds, 1104 installs, identical counts across
arches. Every red came from the checking machinery, each layer on its
first-ever run.

- **Root cause A — the frozen pin and the hidden redirect.** Decisions
  36-38 above carry the mechanism and the fix: live DNS into an nft set, a
  REJECT tail, and a fatal canary.
- **Root cause B — a mountpoint inside a read-only mount.** runc cannot
  make a directory on a read-only filesystem, and crun can, thus the
  nested farm bind never failed locally. The load check now reads the lock
  through the store mount with no nested bind. The same class returned in
  the acceptance script and in the CLI docker-engine path — the CLI now
  makes the `farm`, `current`, and `cache` entries in the store before the
  mounts.
- **Root cause C — the R loader that silently ran nothing.** R caps one
  `-e` expression at 10,000 bytes: past the cap it warns on stdout,
  executes nothing, and exits 0. Behind it, the default DLL cap (614)
  breaks any single session that loads 1100 namespaces. The loader now
  rides stdin, runs sessions of 48 packages four abreast with
  `R_MAX_NUM_DLLS=1000`, and a loader that reports zero verdicts from a
  non-empty batch names itself as the failure.

The discipline lesson, verbatim in spirit: each fault was one local
execution away from discovery before dispatch. The fixed checks ran
against the real store on the local machine before the next dispatch.

### The push transient

Both arch image pushes died on `unknown blob` seconds apart: two jobs
pushed fresh identical-digest layers at the same moment, and GHCR raced
the uploads. The adopted hardening: a three-try backoff around each
`docker push` (landed), a rerun as the normal answer (the layers are
content-addressed), and a bounded push concurrency as a builder-box knob
(`--max-concurrent-uploads` is a dockerd flag, thus it belongs in the
builder configuration in platform-infra, not in the workflow).

### The known noise

`PKG_SYSREQS=false` makes pak list system wants without a check — an
advisory, proven harmless by 1104 clean installs. The 17 Bioconductor
cache-add warnings cost nothing durable: watch, do not chase. The python
inventory drops split into real faults kept out of the inventory (the
check working) and false drops from junk import names, which the emitter
now filters.
