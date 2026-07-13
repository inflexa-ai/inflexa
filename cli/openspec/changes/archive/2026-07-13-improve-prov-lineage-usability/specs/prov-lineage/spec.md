## MODIFIED Requirements

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
explicit "+ n more" tail.

When the substring search also finds nothing, the resolution SHALL make a
final EXACT-IDENTIFIER attempt against every entity and activity: a reference
equal to a record's full prefixed QName (e.g. `inflexa:input-7ai1j57nqx1l`) or
to its bare localpart (e.g. `input-7ai1j57nqx1l`) SHALL resolve to that record
(an entity walks as a file root; an activity as an activity root). Identifier
matching is EXACT, never substring — the token is the document's own address,
copied from the exported PROV.

No match at any tier SHALL fail with a known-paths sample that lists every
entity carrying an `inflexa:path`, regardless of its QName scheme (so a
document whose only pathed entities are inputs still orients the user).
Directory-style references SHALL receive no special semantics — they fail
through the same candidate or not-found messages as any other string.

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

#### Scenario: A QName identifier resolves the record it names

- **WHEN** lineage is asked for `input-7ai1j57nqx1l` (or `inflexa:input-7ai1j57nqx1l`) and no path/hash/substring tier matched it
- **THEN** the named input entity resolves and its lineage renders

#### Scenario: An exact path is never shadowed by the identifier tier

- **WHEN** lineage is asked for a reference that is an exact recorded path AND also happens to equal some record's localpart
- **THEN** it resolves as that path's file entity via the exact-path tier, never via the identifier tier

#### Scenario: A profile-only document still orients an unmatched reference

- **WHEN** lineage is asked for an unknown reference in a document whose only pathed entities are `input-*` (no `file-*` entities)
- **THEN** the not-found failure still lists the input paths as known files

## ADDED Requirements

### Requirement: A mermaid rendering exposes the same graph

The command SHALL render `mermaid`: Mermaid `flowchart` source over the same
flat graph the `json` format exposes, as a pure text formatter with no new
dependency (the CLI emits SOURCE; the user renders it with any Mermaid
consumer). Node ids SHALL be a deterministic, grammar-safe transform of the
prefixed QNames (Mermaid ids cannot carry `:`), one-to-one so distinct records
never collide. Entities SHALL render as rounded nodes and activities as
rectangles (the PROV visual convention); labels SHALL carry the tree's facts —
path and short hash for files; command and exit code, tool, or step-grain
marking for activities — quoted and with Mermaid-significant characters escaped
so a command line containing quotes or punctuation still parses. Edges SHALL be
in PROV semantics regardless of walk direction, visually distinguishing the two
relations (`wasGeneratedBy` solid, `used` dotted), and the edge set SHALL equal
the `json` edge set.

#### Scenario: mermaid output is parseable flowchart source matching the JSON edges

- **WHEN** the same file's lineage is rendered as `mermaid` and as `json`
- **THEN** the mermaid output is a `flowchart` whose node ids are grammar-safe and whose edge set matches the JSON `edges` (same endpoints, PROV orientation)

#### Scenario: A shared intermediate is one node, not a repeated leaf

- **WHEN** a lineage whose tree repeats a shared file as `[already shown above]` is rendered as `mermaid`
- **THEN** that file appears as a single node with several edges, showing the true DAG shape

#### Scenario: Labels with Mermaid-significant characters are escaped

- **WHEN** an activity's command line contains a quote or parenthesis and the lineage is rendered as `mermaid`
- **THEN** the emitted label is quoted and escaped so the source still parses
