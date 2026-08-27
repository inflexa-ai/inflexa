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

## The first-live-run grill (the package-flow truth pass)

The first end-to-end chat run surfaced three faults. The agent asked for
packages that the pool already held. The sidebar mixed the flights into
TRANSFERS, with no progress and no failure affordance. And the agent claimed
an acquisition ordering that no mechanism gives. The grill settled the seven
decisions below.

### 17. The inventory answers per scope (Q1, Q10)

`list_available_packages` reads the farm lock of the analysis, and a new
farm is empty. Thus every pool package read as absent, and the agent asked
for held packages. The conversation agent and the planner get a POOL-scope
inventory, read from `deps.json`, bound at the composition root of the CLI.
The sandbox agents keep the farm view, because a step imports only what the
farm links. The planner grounding reads the same binding, thus the fix
reaches it too.

### 18. Every inventory answer carries the version (Q10)

Each view renders `name==version`. The data exists in each source: the
graph node, the pin marker, and the farm lock. The versionless render and
its rationale in the tool leave. The targeted `names` path, and the
failed-flight dialog, also carry the store directory and the full hash. A
full listing carries no hashes, because a thousand rows of sha256 bury the
signal.

### 19. No chat-time link, and no link approval (Q2 part)

A pool-held package needs no ask and no chat action. The launch links the
package union of the plan into the farm before the run reserves anything.
`link_packages` extends the farm mid-run. Both run without approval,
because a link writes no new content into the pool.

### 20. The launch gate stays, and the remedy classifies (Q7, Q11)

The pool-miss refusal at launch IS the ordering gate: a plan package that
did not land refuses the whole launch, thus no run is wasted. The CLI
remedy wrapper classifies each missing name against its own rows. In
flight: launch again when it lands. Failed: the recorded reason, with
retry or delete. Unknown: the store-add ask. The chat path gains this
wrapper — today only the dev run has one. The prompt gains one rule: never
claim an acquisition ordering that no mechanism gives.

### 21. The sidebar splits into TRANSFERS and PACKAGES (Q3, Q8, Q12)

TRANSFERS keeps the three machine downloads: the runtime image, the
provisioner image, and the catalog. PACKAGES carries the per-analysis
pipeline: the pending adds, the queued and running flights with the newest
provisioner progress line, and the failed rows. A summary line gives the
queued and running counts. The two lifecycles differ, thus one mixed
section misleads — the first live run proved it.

### 22. Each transfer row meters its own progress (Q13)

One meter per row, in the notation of the RUNS embed: label, bar cells,
and `3.2/7.7 GiB`. The image resolve sums the layer sizes from the
registry manifest, thus an image pull gains a real total. An unknown total
falls back to the moving byte count with the age of the last write. A row
that moves is never read as stuck.

### 23. The failed flight opens a dialog (Q4, Q9, Q5)

A failed row in PACKAGES opens a dialog, by mouse or through the palette.
The dialog shows the spec, the phase as one plain sentence, the whole
recorded reason, the store directory, and the hash. The actions are copy,
retry, and delete. Retry enqueues the spec again and starts the detached
flush — the click is the consent. Delete removes the row, and the silent
debris pass frees the bytes. The record stays whole, and only the render
translates the phase.

### The next step of this pass

On confirmation of this record: one OpenSpec change per tree. The harness
change carries the inventory scope, the version render, and the refusal
text of the launch. The CLI change carries the bindings, the remedy
classification, the two sidebar sections, the meters, the dialog, and the
prompt rules.

## The second live-run pass (the spiral postmortem)

The second live run spiraled on one mundane task: add polars, then launch.
The investigation found five defects that stack, and the user set three
directions. The decisions below correct the record, and the corrective
work edits the tree specs directly.

### 24. The 10-second flush gate (issue 1)

The flight starts at the first of three moments: the turn end, an explicit
flush, or 10 seconds after the pending set becomes non-empty. This
supersedes the turn-end-only half of decision 16. The live run showed the
cost: an add approved early sat behind minutes of agent work, and one turn
ended with "launch next turn". The batch argument was weaker than
recorded, because the provisioner resolves each spec alone — a split batch
costs one container run, not correctness. The gate anchors on the first
observation of the non-empty set, and it does not slide, thus a burst of
asks still batches. The transfer poll of the TUI carries the gate, and the
turn-end call stays as the sweep.

### 25. The link runs without an ask in practice (issue 2)

Decision 19 said "no link approval", and the registration gave it half:
`--lang` sat outside the safe flags, and the agent passes `--lang` on its
natural call, thus every call escalated. `lang` joins the safe flags,
because no value of it changes the effect class. A bare `store link` also
resolves the analysis from the anchor of the working directory. The
`run_inflexa` tool runs inside the analysis folder, thus the flag
round-trip through `inflexa ls` leaves.

### 26. The reclaim reference set gains the graph (issue 3)

Plain `store reclaim` removed every directory with no farm link, and a
locally acquired package has none until a run links it. Thus the reclaim
deleted fresh inventory, and it cut a live edge — the dangling edge then
broke every strict graph read. The reference set becomes farm links plus
graph nodes, the same rule the debris pass holds. The `store ls` readout
counts the same set, and its hint says "debris". What removes a regretted
local acquisition is future work, for example a `store remove` command.

### 27. A collision refusal names the dependents (issue 3)

The version-collision error carries the closure members that pull each
pin, as `name==version`. Each render names them: the launch refusal, the
`store link` message, and the `link_packages` outcome detail. The
dependent is the remedy surface — the live run guessed the culprit wrong,
and five turns of store surgery followed.

### 28. A pass that cannot answer says why (issue 3)

An unreadable dependency graph reports `unavailable` with the graph
reason, on every surface: the link seam, the launch refusal, and the
pool inventory of `list_available_packages`. It never renders as a
per-package absence, and it never renders as a bare UNKNOWN. The live run
read the bare UNKNOWN as a transient flake for three turns, while `store
ls` — which reads pins from disk — contradicted it.

## The add-time guards (the convergent pool)

A live probe on the real store settled the uv-add question. Both adds
succeeded, and the pool shelved every pin cleanly. But one stale farm
refused EVERY extension — a polars link too — because a later add
moved a held graph edge. The verdict: no command sequence can produce a
broken state, thus the fix belongs inside the add, and no repair command
exists.

### 29. The first resolution of a store directory is durable

The commit rewrote a held node when a batch staged its directory again,
and every add stages its WHOLE closure — the reused members too. An add
that shared one dependency with held content thus moved a held edge.
The moved edge then blocked every later extension of a composed farm. The
commit now skips a held node, thus no add can invalidate a farm. A repair
command was rejected — the cause leaves, not the symptom.

### 30. The acquire resolves under the pins of the pool

A solo add resolved blind, and it minted a second jinja2 pin while nine
held chains pinned the first. The Python resolve now rides the shelf-head
pins as constraints, and a true conflict drops them — the committed-lock
pattern of the catalog build. A second pin appears only when the ranges
force it. The uv-add flight was rejected as needless. With the two guards
no add sequence can produce a broken state. The collision refusal remains
only for the plan that no resolver can satisfy.

## The catalog-build postmortem (the github track and the OOM)

Two local rebuilds on 2026-08-26 exposed that no catalog build was ever
clean. The record of 24 August was wrong: that build also failed nine
github installs, and the pool held only 5 of the 15 wanted github
packages. Five faults stacked, and each hid behind a best-effort warning.
The user set the rule: a silent degradation of the farm is a defect.

### 31. The egress resolution pins into /etc/hosts

The entrypoint froze the firewall rules from one resolution, but a later
connect resolved again. GitHub rotates addresses under a 60-second TTL,
thus a long build lost the coin flip per connect. The entrypoint now
writes each resolved address into `/etc/hosts` before the rules freeze.
One address set serves the rules and every connect, thus rotation cannot
orphan a permitted host. The fail-loud comment was replaced, not obeyed —
it described a behavior that no one wanted.

### 32. A github build refuses without the token

The token never reached the container, because an unexported shell
variable fed `-e GITHUB_PAT`. Every build ran anonymous at 60 API calls
per hour, and round two died on 403 answers. The build now refuses to
start when the manifest names a github entry and `GITHUB_PAT` is absent.
The refusal is early and loud, before an hour of bulk work.

### 33. The github track installs through pak

`remotes` cannot convert a pak-installed dependency whose DESCRIPTION
says `RemoteType: bioc`, and xCell2 died on it. The bulk installs through
pak, thus the github stage must read what pak wrote. Each repository now
installs through `pak::pkg_install`, best-effort per repository. A probe
proved that pak reuses a dependency that `.libPaths()` already satisfies.

### 34. A failed install keeps the held package

Each build linked only what staged in that round, thus one bad round
removed good packages from the published farm — the farm-level twin of
the moved-edge disease. The farm now keeps the held store directory of a
package that the previous farm advertised, when the pool still holds it.
A dependency carries over only through graph reachability, and a removed
manifest entry never carries over.

### 35. The build machine needs a memory floor

The 5722 MiB podman machine cannot hold three parallel R source builds.
The OOM killer took the EPICanno lazyload twice and the cytolib compiler
once, and the cytolib fall removed 33 dependents. The local machine rises
to 12 GiB. The CI builders size their own memory, and `r_ncpus` remains
the throttle of last resort.

## The third live-run postmortem (the wall against the redirect)

The first CI catalog build died at the 240-minute budget with zero CRAN
packages. The log showed six failures every five minutes for 3.5 hours on
both arches: six download workers, each one against a 300-second timeout.
The spike run of 10 August fetched 1000 binaries green from the same
builders, with no firewall. The wall itself was the fault, two times over.

### 36. A p3m.dev binary GET redirects on a cache miss

The binary route is not one host. On an edge-cache miss, p3m.dev answers
307 to `rspm-sync.rstudio.com/bin/<tag>/<sha256>.tar.gz`, and a HEAD
answers 200 with no redirect, thus a HEAD-based probe reads clean. A cold
CI cache sent every CRAN GET down the redirect, into a host that no
allowlist named. Both allowlists now carry the pair, and the CLI acquire
list gains `p3m.dev` itself, which it also lacked. The canary follows the
redirect with `-L` and prints the final URL, thus a moved target names
itself.

### 37. Decision 31 reverses: the pin froze a 60-second pool

Decision 31 pinned each resolved address into `/etc/hosts` against GitHub
rotation. p3m.dev serves a rotating EC2 pool under a 60-second TTL. AWS
documents that a client that holds an answer past the TTL connects to
inactive addresses. A four-hour freeze is that client. The entrypoint now
follows DNS live: dnsmasq feeds the addresses of each answer into an nft
set before the answer returns, and the rules match the set. nftables
replaces ipset, because the `ip_set` module is not loadable from a
container, and the nf_tables backend is already proven under iptables.

### 38. The wall rejects, and a canary proves both sides

The old policy dropped in silence, and each blocked connect burned its
full timeout — four hours of blindness. The last rule is now REJECT, thus
a blocked connect fails in milliseconds and names the host. A fatal
canary step runs before the build: it sources the same allowlist library,
fetches one pinned-snapshot binary whole through the redirect, and proves
that an off-list host refuses fast. The local rehearsal showed the pair:
234 KB in 1.3 seconds through the wall, and a 9-millisecond refusal.
