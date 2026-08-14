# Design — Agent-Requested Packages

## Context

A farm is a tree of links into the content-addressed pool, mounted read-only at
`/mnt/libs/current`. The embedder composes it and the harness mounts what the
farm provider names (`sandbox/types.ts`, `FarmSource`). The companion CLI change
narrows a farm to the closure that one analysis wants. A narrow farm makes a
missed package fatal, because nothing inside a step can ask for one.

Four facts constrain the design:

1. A sandbox agent runs its tools **in the harness host process**. Only
   `execute_command` crosses into the container. Thus a tool reaches host code
   directly.
2. `SandboxToolName` is a **closed allowlist** (`agents/sandbox/types.ts:16`),
   and an unknown name throws at composition time. A tool joins that list or it
   does not exist.
3. A numba cache entry keys on the **absolute directory of the source file**,
   as the import reads it (`provision.py:924`). Every farm mounts at one
   container path, thus one distribution has one source path in every farm.
4. An extension of a farm is additive, and a bind reflects a new link at once.
   Thus a live sandbox observes it with no restart.

## Goals / Non-Goals

**Goals:**

- A step asks for a package that the pool holds, and it continues.
- One preparation of a cache serves each farm that links that store directory.
- A caller that names no version gets the newest, with no version comparator on
  the host.
- A check proves the cache arrangement that a real analysis uses.

**Non-Goals:**

- Acquisition of an R package. The store cannot do it, and the addition is its
  own change. Refer to the pull request comment that records the gap.
- The narrow default farm, `store link`, and the flight analysis id. The
  companion CLI change owns them.
- A change to the sandbox posture. No network, uid 1000, read-only store — all
  unchanged.

## Decisions

### D1 — The extension is a harness seam, not a command that a tool drives

The harness declares `ExtendAnalysisFarm`: an analysis id and a set of requests
in, one outcome for each request out. The embedder binds a realization. The CLI
realizes it with its host-side composer.

Alternative — a tool that starts `inflexa` as a subprocess: rejected for four
reasons. A sandbox tool already runs in the host process, thus a subprocess
crosses no boundary that needs crossing. A subprocess costs the boot of the
runtime and the load of the configuration and the database. It answers with text
that the agent must read, where a seam answers with a typed result. And the
harness must never depend on an `inflexa` binary, because a managed deployment
has none.

`run_inflexa` earns its subprocess, because the conversation agent drives
arbitrary commands. This is one operation with one shape.

### D2 — The dependency is optional, and its presence yields the tool

`SandboxAgentDeps` carries the seam as an optional member. When the embedder
binds it, `createSandboxAgent` resolves the tool into the surface of each agent.
When the embedder binds nothing, no agent holds the tool.

This is the pattern that `blockerHolder` already uses for `report_blocker`
(`agents/sandbox/shared.ts:130-136`), and that `embedding` and
`citationResolver` use for their tools. It is capability degradation and it is
not a path for compatibility: an embedder that binds nothing has no such
capability, and no code branches on which realization is bound.

### D3 — A request names a distribution or an import name

The evidence that a step holds is an `ImportError`, thus it holds a module name.
`sklearn` is not `scikit-learn`. The graph already carries the mapping in
`DepsNode.imports`, and the field records why it stays parsed: for a caller that
maps an import failure back onto a package.

A request that names a version takes the form of a requirement, for example
`polars==1.2`. One parser reads it, thus the tool, the flight key, and the
command share one grammar.

### D4 — One warm serves every farm, through the home that already exists

Every analysis farm links its cache directories into the catalog template farm
(`composition.ts:911`). Thus one shared home already exists, and nothing moves.

An acquisition warms into that home. Two independent values make this work: the
import path sets the cache key, and the cache path sets where an entry lands. So
a preparation run binds a farm that holds the new package at `/mnt/libs/current`,
and it points `NUMBA_CACHE_DIR` at the shared home.

Fact 3 of the Context is why one entry serves every farm. A farm resolves one
distribution at one container path, thus the key is the same everywhere. The
entrypoint then copies the home to a writable path, because numba selects a cache
directory by a write probe and skips a read-only one.

Alternative — a cache for each farm: rejected. Ten analyses that add one package
would each compile it, and each cache would die with its analysis.

Alternative — a cache keyed by the store directory, beside the pool: rejected. It
relocates every cache to solve a problem that the existing shared home already
solves.

### D5 — The version ordering ships in the graph

The emitter records, for each canonical name, its store directories newest-first.
A caller that names no version takes the head.

The emitter is the right place. It runs inside the provisioner image, where
`packaging` already serves the markers (`emit_deps.py:49`) and where R lives.
Neither ecosystem is semantic versioning: Python is PEP 440, with epochs,
pre-releases, post-releases, and local versions, and R is dotted-decimal. A
string sort is wrong, because `1.10.3` sorts before `1.9.0`.

Alternative — a comparator on the host: rejected. It would be a second
implementation of one rule, in a language with no such library. A drift between
two implementations of one rule is what the farm parity test exists to catch.

A pre-release is not the head unless a farm already links one.

### D6 — The effectiveness check starts the entrypoint

The check of today overrides the entrypoint and copies the caches itself
(`lib-store-provisioner.yml:396-402`). Thus `seed_caches` runs in no check, and
it is the only code that a real sandbox uses for this. The check also reads the
catalog farm, where the cache directories are real directories, and never a
composed farm, where they are links.

The check starts the image as a sandbox starts it, against a composed farm. Then
it proves the arrangement that an analysis uses.

### D7 — One stale requirement is corrected, not extended

`lib-store` states that a change to the package set takes effect "only for
sandboxes created after it". It also holds a scenario in which a sandbox that
runs observes no store change. Fact 4 of the Context contradicts both, and the
companion CLI change specifies a live extension. The requirement keeps the part
that stays true: a step installs nothing itself, the store stays read-only to it,
and it holds no network egress.

## Risks / Trade-offs

- [The on-disk shape of the numba cache] The merge in D4 rests on one entry
  directory for each source directory. `cache_entry_key` records that shape, and
  no test pins it. → A task measures the shape against a published catalog before
  the merge lands. The effectiveness check then fails when an entry does not load.
- [A request that the pool cannot answer] An agent can ask again for a package
  that will never arrive, and burn a step. → The refusal names its reason, and an
  R package carries a reason of its own, thus the agent reads that no retry
  helps.
- [A farm that grows without bound] Each request adds links, and nothing removes
  them inside a run. → The links are cheap, and the farm dies with its analysis.
- [Two writers of one farm] A step extends a farm while the host composes it. →
  The per-farm mutex of the composer serializes them, and both writers are
  additive.

## Migration Plan

1. Land the graph ordering and the preparation of an acquisition run. The graph
   gains a field, and a reader that ignores it is unaffected.
2. Land the seam and the tool. An embedder that binds nothing gets no tool.
3. Land the check through the entrypoint.
4. The companion CLI change binds the seam and narrows the default farm.

## Open Questions

(none — the decisions were settled in conversation with the user)
