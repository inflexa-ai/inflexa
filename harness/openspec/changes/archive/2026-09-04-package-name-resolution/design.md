# Design

## Context

The package store has two tracks, Python and R, and one dependency graph.
Each graph node carries a name, and `by_name` keys the store directories
of a track by that name. The emitter mints the name with `canon()`, the
PEP 503 rule: fold `-`, `_`, and `.` to `-`, then lower the case
(`emit_deps.py:116-123`). The R branch applies the same rule to the
DESCRIPTION name (`emit_deps.py:474`).

PEP 503 is a rule of the Python index. An R name is case-sensitive at
`library()`. Thus `decoupleR` and `decoupler` become one key, and the host
lookup finds the key in both tracks. The same file already keeps the raw R
name for the edge index (`emit_deps.py:495`). The acquire path already
folds a Python name and keeps an R name (`provision.py:1256-1257`). Two of
three paths obey the correct rule.

The host lookup refuses a name that both tracks hold when the request
names no ecosystem (`composition.ts:543-551`). The seam accepts an
`ecosystem` field (`types.ts:85`), and the `link_packages` tool exposes it
(`link-packages.ts:47`). The plan grammar does not: a plan entry is a bare
string, and the link pass never sets the field (`execute-analysis.ts:
120-124`). The prompt text tells the agent that a collision is terminal
(`sandbox-standards.ts:335-336`, `link-packages.ts:39`). The agent obeyed
that text.

A reconstruction of the pool from the manifest, the CRAN and Bioconductor
3.23 metadata, and the Python lock finds eight both-track names. Two exist
only because of the fold: `decoupleR` and `biomaRt`. Six are one spelling
in both ecosystems: `igraph`, `plotly`, `xgboost`, `markdown`, `filelock`,
and `symengine`. `decoupleR` is a transitive import of `cosmosR`. No
manifest entry names it.

## Goals / Non-Goals

**Goals:**

- One identity rule for each ecosystem, applied at every read of a name.
- A plan can name the ecosystem of a package.
- The census tells the planner which names are held by both tracks, and
  it shows the exact string to write.
- A collision has a remedy that the agent can apply.
- A skew between the graph and its reader stops with a named reason.

**Non-Goals:**

- The store directory name stays in the PEP 503 form for both tracks. The
  directory is an address, and the pin marker inside it carries the exact
  name (`provision.py:280-286`).
- The flight key of an acquisition stays as it is. The acquire path already
  carries the ecosystem and the raw spelling.
- No package leaves or enters the manifest.

## Decisions

### D1. The node name obeys the identity rule of its track

The R node name and the `by_name.r` key are the DESCRIPTION spelling. The
Python node name and the `by_name.python` key are the PEP 503 form.

Alternative: one rule for both tracks. That is the current state, and it
manufactured the collision. Alternative: a track prefix on the directory
name. The collision is not in the directory. `by_name` already separates
the tracks, and five parsers of the directory name change for no change in
behavior.

### D2. The host resolves an unqualified name by a precedence ladder

The companion cli change holds the ladder. The design records it here,
because the harness exports the shelf-key rule that the ladder reads.

1. The request names an ecosystem: that shelf only.
2. The R shelf holds the name verbatim, and the name is not in its own
   PEP 503 form: R. An uppercase letter or a dot can only come from an R
   spelling. `decoupleR`, `biomaRt`, `Seurat`, `GO.db`.
3. The R shelf holds the name verbatim, and the Python shelf holds the
   PEP 503 form: ambiguous. The six same-spelling names.
4. The R shelf holds the name verbatim: R. An R name that is its own PEP
   503 form, such as `dplyr`, reaches its package here.
5. The Python shelf holds the PEP 503 form: Python. `decoupler`, `biomart`.
6. Exactly one R key folds to the PEP 503 form of the name: unknown, with
   that key as a suggestion. `seurat` gets `Seurat`.

Alternative: "both shelves hit is ambiguous" with no step 2. `decoupleR`
folds to `decoupler`, and the Python shelf holds `decoupler`, thus the
ladder refuses its own case. Alternative: a silent case-fold for the R
shelf. The fold on the key is the fault of this change. A fold on the
request also hides a graph skew, because the old lowercase key answers it.

### D3. The plan entry carries the ecosystem as a prefix

The grammar is `[python:|r:]<name>[==<version>]`. The bare form stays
valid. The validation refuses any other `<word>:` prefix.

Alternative: an object entry `{ name, ecosystem, version }`. The stored
plan is `string[]`, and a planner writes a string more reliably than an
object. Alternative: a `py-` prefix. A hyphen is a legal character of a
Python name, thus `py-` is also a real name. A colon is legal in neither
ecosystem. The provisioner already speaks `python:` and `r:` as its
internal form (`provision.py:147-149`, `store_flight.ts:120`), and one
vocabulary beats two.

### D4. The graph version becomes 2

The emitter writes `version: 2`. The host reader refuses another version
as `graph_unusable` (`composition.ts:416-420`). A host of version 1
against a graph of version 2 misses every R package silently, because the
keys differ in case. The version turns that silence into one named
refusal.

Alternative: keep version 1. Rejected, because the skew window of a
release is real: the store tag moves before each user applies the update.

### D5. The shelf-key rule has one TypeScript home

`harness/src/sandbox/types.ts` exports `shelfKey(track, name)`. The cli
imports it for the lookup and for the acquisition commit. The Python copy
in `emit_deps.py` is unavoidable, because the emitter runs in the
provisioner image.

Alternative: a second TypeScript copy in the cli. Two copies drift.

### D6. The census stays lenient, and it answers every track

The `names` lookup of `list_available_packages` matches without case, as
it does now, and it returns each track that holds the name. The listing
marks a both-track name with the two prefixed forms.

Alternative: a strict census. A query for `seurat` would then read as
absent against a pool that holds `Seurat`. Then the agent asks for an
acquisition of a package it has. The census answers "what is there, and
what is its exact name". The link is the strict step.

### D7. A collision is a retry, not a terminal

The `link_packages` description and the prompt layer tell the agent to
call the tool again with `ecosystem`. The launch refusal names the prefix.
A collision is terminal only after the retry also refuses.

### D8. The harness change ships first, alone

The prefix resolves every one of the eight names against the current
graph: `r:decoupler` reaches the lowercase R key today. Thus the harness
change unblocks each user before any store rebuild. The provisioner change
and the cli change ship together, because the graph key and the host
lookup must agree.

## Risks / Trade-offs

- [A new host reads an old store] → `graph_unusable` names the two
  versions, and the cli remedy names `inflexa store download --update`.
- [An old host reads a new store] → the same refusal, and the remedy is a
  host upgrade. The refusal is honest, not silent.
- [A plan of the skew window names `r:decoupler`, and the store updates
  before the launch] → the R shelf misses, and rule 6 suggests
  `decoupleR`. The launch refusal carries the suggestion,
  and the planner replans.
- [`store link seurat` stops, where it resolves today] → the refusal
  names `Seurat`. This is the one user-visible regression, and it is the
  correct R semantic.
- [`provision.py:147-149` says the prefix never reaches a user surface] →
  the prefix reaches an agent surface under this change. The comment
  changes with it.
- [The cli fixtures key `by_name.r` in lower case] → the fixtures move
  to the DESCRIPTION spelling. The `go.db` scenario of `farm-composition`
  becomes the suggestion scenario.

## Migration Plan

1. The harness change merges, and the harness releases. The cli pin bumps.
2. The provisioner change and the cli change merge together. The store
   build publishes a graph of version 2 under the moved tag.
3. Each user applies `inflexa store download --update`. Until then, the
   new host reports `graph_unusable` with that remedy.
4. Rollback: revert the host. A reverted host against a version-2 store
   refuses with the version reason, and the previous store tag is the
   remedy.

## Open Questions

None that block the work. The listing marks a both-track name in the full
listing and in a `language` listing alike, because the planner seed reads
the full listing.
