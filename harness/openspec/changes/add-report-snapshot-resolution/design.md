## Context

The block and grounding contract landed as types and a mechanical validator. Its
`ReferenceResolver` seam has one realization, and that realization reads an in-memory
fixture map. Thus a reference never resolves against a real analysis artifact.

A report session freezes at a point in time. The analysis continues after the freeze,
and a later run writes new artifacts under the same analysis. Something must say which
artifacts the session can cite.

Two facts of the current storage shape this design. A completed run output is
immutable, because the path of a run output holds the `runId`, and a new run mints a
new `runId`. But the artifact ledger holds one row for each path, and an upsert
replaces that row. Thus the bytes are stable, and the membership at a past moment is
not recoverable.

## Goals / Non-Goals

**Goals:**

- Mint the set of artifacts of one analysis at a point in time.
- Give the structural validation that runs from that set alone.
- Name the two tiers of resolution, and give the seam of the value tier.

**Non-Goals:**

- The read of a data file. This change gives no realization of the value tier.
- The storage of a snapshot with a report version. #308 owns that work.
- The mint of a citation set. The `citations` field keeps its current shape.
- The gate that runs the value tier for a whole document. #310 owns that work.
- A change to `validateReport`. It keeps its current full resolution through the
  resolver seam, because no caller needs a choice of tier yet.

## Decisions

### The snapshot is an allowlist, not an archive

The snapshot holds identity, and it holds no bytes and no cell. A run output cannot
change under a report, thus the snapshot does not protect the bytes. It answers one
question that nothing else can answer: which artifacts existed at the anchor.

The alternative was to copy the rows of each artifact at the mint. That copy is
unbounded, and the mint cannot know which artifacts the report cites. Thus most of
the copy is waste.

### An entry holds a hash and a file type

The path is the key of the `artifacts` map, and it is not a field of the entry. One
path addresses one artifact across the analysis, thus the map needs no second
identifier.

The hash gives identity. The file type comes from `cortex_artifacts.file_type`, thus
it costs nothing to carry.

The entry holds no size. A size was necessary only to enforce a limit on a read
inside the harness process. The value tier does not read inside that process.

The entry holds no column name. To mint the column names, the harness must open each
tabular artifact at each mint. That cost lands whether or not the report cites a
table, and the value tier catches a wrong column name anyway.

### The harness parses no data file

The value tier stays a seam here. #310 realizes it, and that realization runs a
harness-authored script in the sandbox.

The alternative was a small parser inside the harness. The sandbox is better for
three reasons. It holds the real data tools, thus a large table and a parquet file
both work. It adds no dependency to the harness. It makes a size limit unnecessary,
because such a limit was only a guard on a weak reader.

The cost is that the sandbox is necessary for the value tier. This cost is small. An
analysis made the artifacts that a report cites, and the sandbox is necessary for an
analysis.

### Resolution has two tiers

The structural tier answers from the snapshot, and it opens no file. An authoring
operation runs it on each change. The value tier reads the artifact, and the gate
runs it one time for each version.

Thus the costly read is not per edit, and it is not per cell.

### The file type refuses a kind, and it never confirms one

`inferArtifactType` gives `figure`, `script`, `log`, `notebook`, or `output`
(`harness/src/schemas/artifact-manifest.ts:34`). This is a role, and it is not a data
format.

Thus the rule runs one way only. A `figure`, a `script`, a `log`, and a `notebook`
each refuse a reference that reads a cell. An `output` refuses nothing, because it
covers a table and an image alike. An absent file type also refuses nothing.

Only `artifact-value` and `artifact-table` read a cell. An `artifact-file` pins the
bytes of a whole file, thus each file type is valid for it. A figure block binds
through `artifact-file`, and this rule keeps it valid.

### The mint filters no row

The mint is a projection of the ledger, and it applies no filter. A row that carries
`unrecoverable_at` stays in the snapshot.

The alternative was to drop such a row. Then a reference to it fails with
`artifact-missing`, and that reason is false, because the artifact did exist at the
anchor. The value tier gives `unreadable-artifact` instead, and that reason is true.

### A reference with no artifact pin validates through its inputs

A `citation` holds an external id, and a `derivation` holds two inputs. Neither holds
a path, thus the snapshot has nothing to say about either one directly.

A citation passes the structural tier, and the gate validates it against the citation
resolver. A derivation is grounded exactly when both of its inputs are grounded, thus
the structural tier applies to each input.

### The mint carries the analysis scope

A `Reference` holds no analysis identifier, and that is correct. The document that
holds the reference is already inside one analysis.

The mint takes the analysis, and the snapshot carries the scope from that point on. A
resolver reads the scope from the snapshot, and it never asks the caller again. #318
gets the same scope from the version that stores the snapshot.

### The resolver is not a tool

No agent calls the resolver. An agent finds a value with the read tools that it
holds. Then it authors a reference that asserts the value, and the resolver makes
sure that the assertion is true.

Thus the count of claims in a document sets the count of reads. No agent seeks
through a file on demand.

## Risks / Trade-offs

- **The sandbox is necessary for the value tier.** → The sandbox is necessary for an
  analysis already, thus a deployment that can make an artifact can also read one.
- **The file type gives partial structural power.** → The rule refuses only, and it
  never confirms. The value tier catches a wrong column name and a non-tabular
  `output`.
- **A purged analysis loses its bytes, thus an old version cannot resolve.** → This is
  a question of deletion, and not of mutation. #308 decides whether a version copies
  its referenced values at the cut.
- **A large analysis gives a large snapshot.** → One entry holds three short fields,
  thus the size grows with the count of artifacts and not with the size of the data.

## Open Questions

- Does a version copy its referenced values when the gate accepts it? This question
  belongs to #308, and it decides whether an old report survives a purge.
