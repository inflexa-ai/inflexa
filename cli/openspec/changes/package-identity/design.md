# Design

## Context

The harness change `package-identity` exports one module: the types, the
constructors, `parseQuery`, `formatQuery`, and `resolveQuery` over a
`PoolIndex`. The cli holds the graph, the flight ledger, the two store
commands, and the replay path. Each of them reads a package name today
with a rule of its own. This design makes each of them a consumer of the
module, and it records only the host decisions. The harness design holds
D1 to D9.

## Goals / Non-Goals

**Goals:**

- No fold function in `cli/src`. The one import names the rule.
- No ladder in `cli/src`. The host supplies the pool index and picks the
  version.
- One parser for every argument that names a package.
- A ledger that keys the spelling and the track, never the fold.

**Non-Goals:**

- `store ls` and the sidebar do not change. They print the pin marker.
- The `--lang` and `--version` flags stay. A person names the ecosystem
  with a flag, and the command spec keeps a prefix off the command
  surface.
- The graph version stays 2, as the harness change redefines it.

## Decisions

### D1. The pool index reads the graph

`resolvePackageRequest` builds a `PoolIndex` over `DepsGraph`: `has`
reads `byName[identity.track]` under `identity.name`, and
`rIdentitiesFoldingTo` scans the keys of the R shelf and keeps the ones
whose address equals the fold. It calls `resolveQuery`, and then it picks
the version: the head of the shelf when the query names none, the exact
match when it names one, and `unknown_version` otherwise.

Alternative: keep the ladder in the cli and call it from the census
through a seam. Rejected, because the census then depends on the host for
a rule that is host-agnostic.

### D2. The refusal shapes carry identities

`unknown_distribution` carries `suggestion` as an identity key.
`ambiguous_ecosystem` carries the two identity keys beside the two head
directories. The `name` field of each shape goes, because no render read
it. Every render reads `query.spelling`, and `describeRequestRefusal`
takes the query.

### D3. The ledger keys the spelling and the track

The flight id is `<track or any>::<spelling>::<specifier>`. The two
request tables hold `spelling`, `ecosystem`, and `specifier`. Migration 10
rebuilds both tables, and it fills `spelling` from `raw_name`, or from
`name` when `raw_name` is null. The dedupe compares the three columns.
Two spellings of one fold are two rows, because they are two queries.

Alternative: keep the folded `name` column beside `spelling`. Rejected,
because a folded column is the fourth copy of the fold, in SQL.

### D4. A pool miss classifies by identity

`classifyPoolMiss(query)` matches a row by identity when both carry a
track. It matches by spelling when neither carries a track. A Python flight for `seurat` and an R
query for `Seurat` do not match, because their identities differ.

### D5. The command surface parses a query and keeps its flags

`store add` and `store link` parse the argument with `parseQuery`. A
version inside the argument is the version. `--version` and `--lang`
merge into the query. A prefix inside the argument refuses with the
`--lang` remedy, because the command spec keeps the prefix off the
command surface. A flag and a value in the argument that disagree refuse.
The replay path of `inflexa run --plan` parses each plan entry with
`parseQuery`, thus a replayed plan reads the same grammar as the launch.

### D6. The acquisition commit and the spec use the module

A bare edge of a staged node resolves through
`identityOf(node.track, edge).name` on the shelf of the track.
`provisionerSpec` is `formatQuery`. The spec dictionary that crosses to
the provisioner carries the query, and the provisioner parses it with
the twin.

### D7. The reader ignores `r_dir`

`GRAPH_VERSION` stays 2. The node schema of the reader holds no `r_dir`,
and an extra field passes through unread. A development store from this
branch carries the field until it rebuilds.

## Risks / Trade-offs

- [Migration 10 rebuilds two tables] → migration 7 rebuilt the same tables,
  and the pattern is proven. A live flight row keeps its `raw_name` as its
  `spelling`.
- [`store add go.db --lang r` becomes its own flight] → the R probe misses,
  and the flight refuses with "no ecosystem holds the name". The pool
  suggestion does not apply to an acquisition. That is the strict
  semantic, and it is honest.
- [The census and the link now agree on `seurat`] → both answer absent
  with the suggestion `Seurat`. A user who typed `seurat` sees the same
  answer in both places.

## Migration Plan

- Migration 10 runs at the next start of the cli.
- A development store from this branch rebuilds with the store build.
- This change lands with the harness change, because the seam type
  changes shape.

## Open Questions

None.
