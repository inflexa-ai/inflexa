## Context

Two reference implementations of the read side existed before this change:

- The CLI's `prov lineage` module: node classification from `prov:type` with a
  QName-prefix fallback, the run/step spine read as a label off the
  communication adjacency, and a directional, cycle-safe, depth-bounded walk
  over ONLY the generation and usage edges.
- Lumen's `deriveLineageGraph`: a flat node/edge model over the whole document,
  with synthesized placeholder nodes for undeclared relation endpoints,
  value-derived fallback ids for anonymous lifecycle relations, and a silent
  skip of statement kinds outside its edge set.

The two agree on the dialect facts. They differ in shape and in edge
orientation, and each carries presentation the kernel must not absorb.

## Goals / Non-Goals

Goals:

- One derivation from stored bytes to a typed model, one traversal, one
  `(path, hash)` lookup — in the kernel, next to the write-side mapping.
- CLI semantics are canonical for the traversal. Lumen tolerance is adopted
  for the derivation.

Non-Goals:

- No presentation: no tree/JSON/dot/mermaid rendering, no hash-prefix ref
  search, no candidate caps, no React Flow layout. Those stay in the hosts.
- No write-path change. The read model must not touch the builders, and the
  golden fixture bytes must not move.

## Decisions

### Read drift is why this layer is kernel-owned

The write path determines the signed bytes; the read path does not. Thus read
drift never corrupts a document — it produces INCONSISTENT VIEWS: two
consumers show two different lineages for one signed record, which defeats the
point of a canonical signed document. The interpretation (which attribute
carries a fact, which relation is a lineage edge, which direction a walk
follows) is dialect semantics, and the kernel owns the dialect on both sides.

### The input is the PROV-JSON string

`deriveLineageModel` takes the serialized document — the exact bytes a host
stores and the signature covers — not a tsprov `ProvDocument`. Every consumer
then interprets one canonical form, no consumer needs tsprov plumbing at its
boundary, and a parse failure surfaces on one typed err channel
(`prov_corrupt`). The document unifies under `PROV_UNIFY_OPTIONS` before it is
read, so the model sees the last-write-wins survivor of each record — the same
fold the write path serializes under.

### CLI semantics are canonical for the traversal

`computeLineage` ports the CLI's walk exactly: only `generated` and `used`
edges traverse (the coarse `derived` edge to the analysis and the `informed`
spine would pollute a file's lineage); `depth` counts file-level hops, bounded
as `2n` edges from a file root and `2n - 1` from an activity root, so a
truncation always lands on a file node; a multi-root walk bounds each node by
its minimum distance over all roots. One deviation: the CLI engine's
`MAX_WALK_DEPTH` ceiling for the unbounded case is not ported — a
breadth-first walk over a finite edge list terminates without it.

### Lumen tolerance is adopted for the derivation

Three behaviors port from Lumen: a relation endpoint the document never
declares synthesizes a minimal node (kind from the QName-localpart prefix); an
anonymous lifecycle relation gets the deterministic value-derived fallback id
`{kind}:{from}->{to}`; a statement kind outside the seven — delegation today,
any future kind — is skipped, never an error. A command's `runId`/`stepId`
inherit from its informing step (both references do this; the CLI's
both-undefined guard is taken).

### Edges are in the PROV assertion orientation

The one genuine conflict between the references: the CLI's flat projection
emits edges in the PROV assertion orientation (a `generated` edge points
entity to activity), while Lumen flips every edge into dataflow orientation
for React Flow. The kernel takes the assertion orientation — formal argument 0
to formal argument 1, exactly as the dialect asserts the relation — because
the dataflow flip is a rendering concern a consumer can apply in one line.

### The node unions extend the sketch where the dialect requires it

Entity nodes are three kinds (`analysis`, `input`, `file`), not one: the
dialect declares analysis and input entities, and without them their lifecycle
relations would dangle into synthesized placeholders. Activity kinds include
`file_tool`: `inflexa:FileToolWrite` is a distinct dialect type both
references keep apart from `command`. Lumen's derivation of `runId`/`stepId`
from an entity's path is NOT ported — it reads host storage layout, not the
dialect, and stays a Lumen filter concern.

## Risks / Trade-offs

- **The kernel now versions with the read vocabulary.** A new node fact or
  edge kind bumps the kernel. Accepted: the same argument that moved the event
  switch — one interpretation, written once.
- **Hosts keep private readers for host concerns.** The CLI's ref search and
  Lumen's path-derived run/step filter still read the document directly.
  Accepted: both are presentation/host-layout concerns; the dialect facts they
  share now come from one module.
