## MODIFIED Requirements

### Requirement: The kernel owns the lineage read model

The kernel SHALL provide the one read-side interpretation of a stored dialect
document. `deriveLineageModel(provJson)` SHALL take the exact stored PROV-JSON
string, unify it under `PROV_UNIFY_OPTIONS`, and return a
`{ nodes, edges }` model: typed, presentation-free nodes (`analysis`, `input`,
and `file` entities, `activity` nodes with the kinds `run`/`step`/`command`/
`file_tool`/`action`, and `agent` nodes with the kinds
`system`/`user`/`model`) and edges for exactly the seven relation kinds
`used`, `generated`, `informed`, `derived`, `attributed`, `associated`, and
`invalidated`. An edge SHALL point in the PROV assertion orientation (formal
argument 0 to formal argument 1) and SHALL carry a deterministic id: the
relation's dialect id when one exists, else the value-derived fallback
`{kind}:{from}->{to}`. A relation endpoint the document never declares SHALL
synthesize a minimal node from its QName; a statement kind outside the seven
SHALL be skipped; bytes that do not parse or unify SHALL return
`err({ type: "prov_corrupt" })`. `computeLineage(model, roots, options)` SHALL
traverse ONLY the `generated` and `used` edges, forward or backward, with a
file-hop `depth` bound of `2n` edges from a file root and `2n - 1` from an
activity root, so a truncation lands on a file node, and SHALL return the
reached sub-model plus `truncated`: the QNames of the in-scope nodes with at
least one qualifying edge the depth bound left unexpanded, computed in the
same single traversal and equivalent to diffing the walk against the same
walk one file hop wider. A node at the bound with nothing beyond it SHALL NOT
be truncated. `computeReachable(model, roots, options)` SHALL return the
unbounded reachability closure of the roots as a reached sub-model: every
edge kind traverses by default, `edgeKinds` narrows the set, direction is
`forward`, `backward`, or `both`, and `both` SHALL be the union of the
backward and forward closures from the same roots — not undirected
connectivity. `findFileEntity(model, key)` SHALL return the file entity for a
`(path, hash)` key. The read model SHALL NOT touch the write path: the golden
fixture bytes do not change.

#### Scenario: The golden document derives into the shared model

- **GIVEN** the committed golden fixture bytes
- **WHEN** `deriveLineageModel` runs
- **THEN** every declared element is a typed node, every undeclared relation
  endpoint is a synthesized minimal node, and each execution relation keys its
  edge by its deterministic dialect id

#### Scenario: Tolerance for anonymous and unknown statements

- **GIVEN** a document with an anonymous lifecycle relation and a statement
  kind outside the seven
- **WHEN** `deriveLineageModel` runs
- **THEN** the anonymous relation gets the value-derived fallback id, and the
  unknown statement kind is skipped with no error

#### Scenario: The walk traverses only generation and usage

- **GIVEN** a derived model of a produced file
- **WHEN** `computeLineage` walks backward from the file
- **THEN** the result holds the file-to-command-to-input chain, and the
  analysis entity, the run spine, and the agents stay out

#### Scenario: Depth counts file hops and truncates on a file node

- **GIVEN** a chain of two commands between three files
- **WHEN** `computeLineage` walks backward from the last file with depth 1
- **THEN** the result ends at the intermediate file, and the earlier command
  and its inputs stay out

#### Scenario: The walk reports its own truncation

- **GIVEN** a chain of two commands between three files
- **WHEN** `computeLineage` walks backward from the last file with depth 1
- **THEN** `truncated` holds exactly the intermediate file — the node whose
  producer lies beyond the bound — and a bound node with nothing beyond it,
  or an unbounded walk, reports no truncation

#### Scenario: The reachability closure serves a highlight consumer

- **GIVEN** a derived model and one produced file
- **WHEN** `computeReachable` runs with direction `both` and the default edge
  kinds
- **THEN** the reached sub-model holds the file itself, its producing command
  and the run spine, the agents via association and attribution, and the
  analysis via derivation, while a sibling command's exclusive output stays
  out
