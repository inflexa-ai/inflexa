## MODIFIED Requirements

### Requirement: The walk marks cycles and depth cutoffs instead of hiding them

The traversal SHALL keep a visited set and render a revisited entity as an explicit
reference marker rather than re-expanding it (a command that writes and re-reads one
path records `generates ∧ uses` on the same entity — a real cycle). A `--depth`
bound SHALL render an explicit truncation marker at the cutoff, and "unbounded"
SHALL be backed by the graph engine's hard safety ceiling (1000 edge traversals —
about 500 file-level hops, since one file→activity→file step is two edges) that
truncates with the same marker rather than exhausting the call stack on a
pathological chain. One CLI `--depth` unit SHALL mean one file-level hop
(file → activity → file), regardless of how the underlying engine counts. Nothing
in any rendering SHALL make a truncated or cyclic branch look like a completed one.

#### Scenario: A self-read cycle renders once

- **WHEN** one command both generated and used the same `(path, hash)` entity and lineage is asked for that path
- **THEN** the walk renders the entity once and marks the re-encounter as a reference, and the command terminates

#### Scenario: Depth bound is explicit

- **WHEN** lineage is asked with `--depth 1` on a chain three hops deep
- **THEN** the output ends the bounded branch with a truncation marker, not a clean leaf

#### Scenario: Depth counts file hops, not engine edges

- **WHEN** lineage is asked with `--depth 1` for a file produced by a command with recorded inputs
- **THEN** the walk shows the producing activity AND its input files (one full file-level hop) before truncating — the cutoff never lands mid-hop on the activity

### Requirement: Tree and JSON renderings expose the same walk

The command SHALL render `tree` (default) — one lineage per resolved entity, inputs
indented beneath their producing activity — and `json`: a flat graph
`{ roots, nodes, edges }` with nodes keyed by prefixed QName (e.g.
`inflexa:file-…`) carrying kind-specific fields (path/hash for files;
command/exitCode, tool, runId/stepId for activities) and edges in PROV semantics
(`wasGeneratedBy` entity→activity, `used` activity→entity) regardless of walk
direction. When several entities resolve from one reference, the JSON SHALL be one
merged graph whose `roots` lists every resolved entity, and a node SHALL be marked
`truncated` only when NO expansion of it was recorded anywhere in the walk.

#### Scenario: JSON is a flat, direction-independent graph

- **WHEN** the same file's lineage is rendered as `json` backward and forward
- **THEN** both emit `nodes` keyed by QName and `edges` in PROV semantics, differing only in `roots` and reachable subset — a script can re-derive either direction from the edges

## ADDED Requirements

### Requirement: A dot rendering exposes the same graph

The command SHALL render `dot`: a Graphviz `digraph` over the same flat graph the
`json` format exposes, as a pure text formatter with no new dependency (consumable
via `| dot -Tsvg`). Node ids SHALL be the prefixed QNames; labels SHALL carry the
tree's facts — path and short hash for files; command and exit code, tool, or
step-grain marking for activities — with `"` and `\` escaped. Files and activities
SHALL be visually distinct, truncated nodes SHALL be visibly marked (never rendered
as clean leaves), and edges SHALL be in PROV semantics (`wasGeneratedBy`
entity→activity, `used` activity→entity) regardless of walk direction.

#### Scenario: dot output is a pipeable digraph matching the JSON edges

- **WHEN** the same file's lineage is rendered as `dot` and as `json`
- **THEN** the dot output is a syntactically valid `digraph` whose edge set matches the JSON `edges` (same endpoints, PROV orientation), suitable for `dot -Tsvg`

#### Scenario: Truncation is visible in dot

- **WHEN** a `--depth`-bounded walk cuts a branch and the lineage is rendered as `dot`
- **THEN** the truncated node is visibly marked in the graph output, not rendered as an ordinary leaf

### Requirement: An unmatched reference falls through to substring search

The resolution SHALL, when the exact-path, exact-hash, and hash-prefix probes
all miss, search the reference as a case-sensitive substring over exactly three
targets: recorded file paths (`inflexa:path` on entities), command lines
(`inflexa:command` on activities), and tool names (`inflexa:tool` on activities).
Content hashes SHALL NOT be substring-searched — hash addressing stays
exact-or-prefix. A single matched record SHALL resolve and be walked. Matches
that are all file entities carrying the SAME path SHALL collapse to that path's
entity set and walk like an exact-path multiplicity. Any other multiplicity —
several distinct paths, several activities, or a mix — SHALL fail with a
kind-tagged candidate listing (files as path with hash; activities as their
command or tool line with step and run), capped at 10 candidates with an
explicit "+ n more" tail. No match at all SHALL fail with the known-paths
sample. Directory-style references SHALL receive no special semantics — they
fail through the same candidate or not-found messages as any other string.

#### Scenario: A unique filename fragment resolves

- **WHEN** lineage is asked for `heatmap` and exactly one recorded path contains it
- **THEN** that file's lineage renders exactly as if the full path had been given

#### Scenario: A command fragment roots the walk at the command

- **WHEN** lineage is asked for `plot.py` and it matches no path but exactly one recorded command line
- **THEN** the walk roots at that command activity

#### Scenario: An ambiguous fragment fails with kind-tagged candidates

- **WHEN** lineage is asked for `output` and several distinct recorded paths (or a path and a command) contain it
- **THEN** the command fails listing each candidate tagged by kind, capped with an explicit remainder count, and walks nothing

#### Scenario: A fragment matching one path written twice walks both entities

- **WHEN** the fragment's matches are all entities of one path recorded under two hashes
- **THEN** both entities resolve and render one lineage each, labeled by hash

### Requirement: Lineage can root at a command activity

When a reference resolves to a command activity, the traversal SHALL root the
walk there: backward, the tree renders the activity's own fact line (command
and exit code, or tool, with its step and run) as the root, with the files it
`used` beneath, each expanding transitively as a normal file node; forward, the
files it generated, likewise expanding. A `--depth` bound SHALL still count
file-level hops beneath the root. The JSON and dot renderings SHALL carry the
activity's QName among `roots` with no change of shape.

#### Scenario: Backward from a command shows what it consumed

- **WHEN** lineage is asked for a reference resolving to command B and walked backward
- **THEN** the tree roots at B's fact line with B's input files beneath, each carrying its own ancestry

#### Scenario: Forward from a command shows what it produced

- **WHEN** the same reference is walked with `--forward`
- **THEN** the tree roots at B's fact line with B's generated files beneath, each carrying its downstream readers

#### Scenario: JSON roots carry the activity

- **WHEN** an activity-rooted walk is rendered as `json`
- **THEN** `roots` contains the activity's QName and its node carries the usual command facts
