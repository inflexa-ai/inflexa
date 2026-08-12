# Design — Per-Analysis Farms

## Context

The store on disk is one pool (`store/`), farms (`farms/`), and one pointer
(`current`). The CLI writes the pointer at download (`store_download.ts:659-668`)
and switches it with `store use` (`store.ts:525-560`). The harness follows it at
sandbox creation (`docker-client.ts:126-135`). The harness companion change
`per-analysis-farm-mount` removes the pointer from the mount contract and mounts
a farm per sandbox. This change is the embedder half: who makes the farms, when,
from what, and how concurrent acquisition behaves.

The catalog is one solved set — CI resolved every package together. Thus any
selection inside it is version-consistent by construction. The graph `deps.json`
(published per the harness change) carries resolved edges: exact store-directory
names, no version ranges.

## Goals / Non-Goals

**Goals:**

- Each analysis owns a farm named `farms/<analysisId>`, made lazily, extended on
  demand, and removed with the analysis.
- Composition is host-side and containerless, thus it costs milliseconds, not a
  container start.
- Concurrent `store add` requests dedup per spec, run in parallel across specs,
  and report through the same lifecycle surfaces as the store download.
- An existing store upgrades in place.

**Non-Goals:**

- The mount mechanics, the provider seam shape, and the provisioner lock
  discipline. The harness change owns them.
- A farm for a non-analysis surface. Chat and the planner read no farm.
- R acquisition through `store add`. The command stays Python-first, and the R
  tracks arrive with the catalog. The composition module covers both tracks,
  because the catalog holds both.

## Decisions

### D1 — Composition is a graph walk in TypeScript, pinned by a parity fixture

The composer reads `deps.json`, takes the closure of the requested roots, and
makes the three link shapes the provisioner makes: top-level entry links with
namespace-directory promotion, R inner-directory links, and the relative bin
hoist (`provision.py:283-316,384,678`). It writes the farm markers
(`packages.txt`, `meta.json`, `lock.json`) with the shared inventory shape.

Two implementations of one layout is a real risk. A golden-fixture parity test
pins them: one fixture pool, composed by both implementations, compared
tree-for-tree. The test lives in the CLI and runs the Python composer in CI.

Alternative — run composition inside the provisioner container: rejected. It
puts a container start and an engine requirement on the first-sandbox path, and
the walk needs no toolchain.

### D2 — Lazy creation inside the farm provider

The provider the CLI hands the harness does the work: on a miss it composes the
farm, then it returns the path. Thus "make at first sandbox" is not a separate
hook — the first sandbox action triggers composition by construction. A
composition failure returns no farm, and the harness gate names the state.

The default closure of a new farm is the requested set of the catalog template.
That is the same set `current` served before, so the first sandbox behaves as
today.
The profiling flow narrows or extends it later through the same composer.

Alternative — compose at `analysis new`: rejected, a chat-only analysis would
pay for a farm it never mounts.

### D3 — Extension is additive and safe under a live sandbox

An extension links new store directories into the existing farm. It touches no
existing link, thus a live sandbox keeps every resolution it made. The bind
reflects the new links, and the next import attempt inside the same sandbox
resolves them. A per-farm mutex (an instance-lock file beside the farm)
serializes two compositions of one farm, because namespace promotion re-writes
a link as a directory.

### D4 — Flights: one row per spec, subscriptions, zero-subscriber stop

`store add` orchestration mirrors the detached download lifecycle:

- The flight key is the normalized spec: `(ecosystem, canonical name,
  specifier)`. One live flight per key. A second request for the key subscribes
  and reports the same progress.
- A subscription belongs to an analysis. A cancel removes one subscription. The
  flight stops when none remains.
- A finished flight is not a cache: a failed flight clears its row, and a later
  request starts fresh.
- Flights for different keys run concurrently, capped by a configured limit
  (default 2), because an R source compile can exhaust memory.
- On success the flight commits: the provisioner appended the graph under its
  commit mutex, and each subscribing analysis's farm extends with the new
  closure.

The user-facing shape — one DB row, named states, an instance lock for
liveness, sidebar progress — is the `lib-store-download-process` pattern
applied to a second writer.

### D5 — The download merges a template, not an environment

The merge keeps its receipt pattern and its per-child renames, and it drops the
`current` step. The catalog farm keeps its name and becomes the template: the
composer reads its `lock.json` for the default closure and links its warm-cache
directories into each analysis farm. `deps.json` merges as a top-level store
record. On `--update`, a graph from the new catalog replaces the old graph
under the same store-level metadata mutex the flights use.

### D6 — The planning inventory reads the pool

`list_available_packages` answers planning, and planning now selects from
everything the pool can link, not from one farm's links. The store-level
inventory (rederived at each commit) is that answer. The in-sandbox truth stays
the farm the sandbox mounts, which is exactly what the analysis composed.

### D7 — Farm death follows the analysis

`analysis delete` removes `farms/<analysisId>` after the lease check the
harness change keeps. Reclaim gains a reaper pass: it removes a farm whose analysis id no longer
exists in the DB. Thus a DB reset or a crashed delete cannot strand a farm
forever. Reclaim then frees pool directories that no
farm references, unchanged.

### D8 — Migration is one idempotent step

The first store command after upgrade removes a stale `current` symlink. Old
harness binaries resolve `current` until then, per the harness change's
rollback note. No farm is rebuilt: existing farms stay valid because their
links never involved the pointer.

## Risks / Trade-offs

- [Layout parity drift] The TS composer and the Python farm builder diverge
  silently. → The golden-fixture parity test compares full trees on every CI
  run. A divergence fails with a path diff.
- [Default-closure size] The catalog template closure links the whole catalog
  set into every farm, at some thousands of symlinks per farm. → Links are
  cheap, measured in milliseconds and kilobytes. If profiling later narrows
  defaults, the composer already accepts any root set.
- [Import-failure loop latency] An on-demand extension costs a round trip
  through the agent. → The default closure makes the loop rare. The loop is the
  net, not the norm.
- [Two writers of one farm] A flight commit extends a farm while its analysis
  composes. → The per-farm mutex serializes them, and both writers are
  additive.
- [Stale graph after a failed append] A flight that dies between pool write and
  graph append leaves pool entries the graph does not name. → Composition never
  links them (it walks the graph), and reclaim removes them. The next flight
  for the spec redoes the work.

## Migration Plan

1. Land the harness change first — the seam accepts a provider while the old
   single-mount path still works.
2. Land composition and the provider wiring. From here new sandboxes mount
   per-analysis farms.
3. Land the `store use` removal, the flight orchestration, and the merge
   change.
4. The stale-pointer removal ships with step 3 and runs on first use.

Rollback before step 3 is config-free: without a provider the harness follows
the pointer as before, and the pointer still exists until step 4 ran.

## Open Questions

(none — the decisions were settled in conversation with the user)
