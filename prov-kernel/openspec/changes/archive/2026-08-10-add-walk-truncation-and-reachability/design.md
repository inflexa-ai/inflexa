## Context

The 0.4.0 walk (`computeLineage`) is a breadth-first traversal over the
generation/usage adjacency, keyed by the best remaining edge budget per node.
It returns the reached sub-model and nothing else. Two consumer-side
workarounds existed against that surface:

- Truncation by diff: run the same walk at `depth` and `depth + 1`; every edge
  only the wider walk records whose walk-direction source (backward =
  `edge.from`, forward = `edge.to`) sits inside the bounded scope marks that
  source as truncated. Two full walks for one fact the bounded walk already
  encountered.
- A private bidirectional traversal: the walk is hardwired to the
  generation/usage edge set, so a consumer that needs a node's full cone —
  agents via association/attribution, lifecycle context via derivation — has
  to re-implement reachability over the raw edge list.

## Goals / Non-Goals

Goals:

- The bounded walk reports its own truncation, in the same single pass,
  provably equivalent to the depth+1 diff derivation.
- One reachability primitive over a chosen edge-kind set, so a highlight
  consumer is one call.
- One traversal core under both functions.

Non-Goals:

- No change to the lineage walk's depth semantics or edge set. Lineage stays
  generation/usage; a consumer that wants other kinds uses `computeReachable`.
- No depth parameter on `computeReachable` — it is reachability, not lineage.
- No write-path change; the golden fixture bytes must not move.

## Decisions

### Truncation is computed in the walk, not by a wider re-walk

An edge is recorded only by expanding its traversal-direction source, so a
node whose final budget is exactly 0 while it has qualifying edges at all has
those edges unexpanded — the walk knows its own frontier. This is equivalent
to the diff derivation: in the walk one file hop wider, every root budget
grows by exactly 2 edges, so a node with final budget 0 gains a positive
budget and records precisely its unexpanded edges, whose source it is. A node
at the bound with an empty adjacency is genuinely empty in both derivations
and stays unmarked. The equivalence is asserted by a test that cross-checks
the in-walk set against the diff derivation over varied fixtures, root sets,
directions, and depths.

### `truncated` is a QName array on the walk result

`LineageWalk = LineageModel & { truncated: string[] }` — the result stays
usable wherever a model is accepted (re-walking a sub-model, entity lookup),
and the addition is additive for every existing consumer. Arrays match the
model's own collection style (`nodes`, `edges`); the order is the walk's
deterministic discovery order.

### Reachability is a separate primitive, not a walk option

`computeReachable(model, roots, { direction, edgeKinds? })` returns the
reached sub-model. Folding edge-kind options into `computeLineage` would
overload the lineage semantics (file-hop depth is meaningless over
association or derivation edges). The two share the traversal core; only the
budget (always unbounded) and the edge-kind set differ.

### `"both"` is the union of two directional closures

Backward follows the asserted edges, forward reverses them, and `"both"` runs
both from the same roots and unions the result. This is the
upstream-plus-downstream cone a highlight consumer wants — NOT undirected
connectivity, which would leak a sibling consumer of a shared input into the
cone.

## Risks / Trade-offs

- **The walk result type widens.** `computeLineage` now returns `LineageWalk`,
  a subtype of the old `LineageModel` return. Additive for consumers;
  accepted for a minor bump.
- **`computeReachable` default is every edge kind.** A future eighth relation
  kind would silently join the closure. Accepted: the default serves the
  full-cone consumer, and `edgeKinds` pins the set for anyone who needs
  stability.
