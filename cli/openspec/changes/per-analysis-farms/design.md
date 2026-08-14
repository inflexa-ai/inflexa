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

The farm is made at `analysis new`, and it starts empty. Two facts force that.
The planner names packages into a farm, thus the farm must exist before the
planner runs. And an empty farm is a directory with a few markers, thus it costs
almost nothing for an analysis that never runs a step.

Composition links what a caller names, and nothing else. No package set lives in
the store, in an agent, or in this design. Such a set hardcodes a choice, and it
goes stale against the catalog that it came from.

The contents arrive by two routes. The planner gives the set that its plan wants:
what the pool holds links, and what the pool lacks becomes an install request to
the user. A step then links what the plan missed, through the tool.

The extras gap stays real: the emitter evaluates a marker with no extra active,
thus a closure walk can miss a distribution that only an extra names. Measured on
the published catalog, a walk lost 16 distributions. Under this design that loss
is loud and recoverable — the import fails with a module name, and the step links
it. Under a copy of the catalog it was invisible, and that is the trade this
decision accepts.

Alternative — compose at the first sandbox action: rejected. The planner runs
before that, and it would have no farm to name packages into.

Alternative — a base set in the store, or a package list on an agent: rejected.
Both hardcode a set, and the link tool already covers the case that they were
meant to solve.

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
  specifier)`, joined with `::`. Neither ecosystem permits a colon in a package
  name, thus the first two occurrences are always the separators. The key holds
  no control character: a source file that carries one reads as binary to `grep`
  and to `file`, and a search on it then returns nothing with no warning.
- One live flight per key. A second request for the key subscribes and reports
  the same progress.
- A subscription belongs to an analysis. A cancel removes one subscription. The
  flight stops when none remains.
- A finished flight is not a cache: a failed flight clears its row, and a later
  request starts fresh.
- Flights for different keys run concurrently, capped by a configured limit
  (default 2), because an R source compile can exhaust memory.
- On success each caller extends its own farm, and the owner extends no farm but
  its own. An owner that died between the acquisition and the extension would
  otherwise leave a subscriber short. The row that named the subscribers is gone
  by then. Each caller knows its own analysis, thus no list is necessary.

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

### D9 — `store add` and `store link` are two commands, not one flag

Two operations hide under one name today. An acquisition opens the network,
starts the provisioner container, and takes minutes. A link writes symlinks from
the pool and takes milliseconds. The two take different consent from the user,
thus they take different policies.

`cli/CLAUDE.md` settles the shape. An option must never change the effect class
of a command, and the policy binds to a command and never to a flag. Thus
`store link` is a subcommand with the `auto` policy, and `store add` keeps
`approval`.

The planner acquires, before a run, with the consent of the user. A step links
only. Thus a run never stops for a prompt, and a package that the pool lacks
fails that step with a reason which says so.

Alternative — one command with a flag that means "link only": rejected. The
registry binds a policy to a command, thus a flag cannot carry one.

### D10 — Composition waits on a reclamation

A narrow farm walks the graph, thus it can reach a store directory that no farm
links yet. A reclamation between the walk and the link would remove it, and the
farm would hold a link that resolves to nothing.

The wait is cheap. The reclamation lock is a host advisory lock (`lib/lock.ts`),
and an acquisition flight already polls it. Composition polls the same lock, and
a reclamation waits for each live composition before it deletes.

Alternative — composition takes the store lock of the provisioner: rejected. That
lock is container-scoped, thus a wait on it would put a container start on the
first-sandbox path.

Alternative — a reclamation spares each store directory that the graph names:
rejected. The pool would never shrink while the graph holds a name, thus a
superseded version would stay forever.

## Risks / Trade-offs

- [Layout parity drift] The TS composer and the Python farm builder diverge
  silently. → The golden-fixture parity test compares full trees on every CI
  run. A divergence fails with a path diff.
- [A step that pays round trips] An empty farm can meet more than one missing
  import. Each one costs a request out of the step and back. → The planner names
  what a plan wants, thus one link pass serves the common case.
- [The data profiler runs before any plan] It is a sandbox step, thus its farm is
  empty when it starts. → It holds `link_packages` like every sandbox agent, and
  it links what it imports. The cost is round trips on the first profile, and no
  hardcoded set buys that back.
- [Extras under-linking] The no-extra marker evaluation drops the optional-extra
  edges of Python. Thus a closure walk can miss an optional dependency, and no
  farm is exempt now that none copies the catalog. → The import failure names the
  module, and the step requests it through the seam.
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
