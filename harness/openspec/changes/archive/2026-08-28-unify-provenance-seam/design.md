# Design

## Context

Three provenance duties live in three places today:

- the run emit `emitProvenance` on the workflow deps
  (`workflows/execute-analysis.ts:348`)
- the report observation seam (`tools/report-observation.ts`)
- the document source seam (`tools/report-provenance.ts`)

The review of PR #467 directs one surface. The pinned plan is
`pr467-feedback-plan.md` at the repository root, and the sketch there is the
contract of this change.

## Goals / Non-Goals

**Goals:**

- One `ProvenanceSeam` type carries the three duties.
- The emit sites and their events stay as they are, with `blockKind` added to
  the four block events.
- The composition root of an embedder binds one object.

**Non-Goals:**

- No change to the `ArtifactRegistry` seam. Artifact registration is its own
  concern of the five seams.
- No change to the payload of the run events.
- No provenance format enters the harness. The bytes stay opaque.

## Decisions

### D1 — a bag of three optional members, not one widened emit

`ProvenanceSeam` holds `emitRunEvent`, `emitSessionEvent`, and `readExport`,
each optional alone. The alternative is one event union with one emit and an
optional session. It saves one member, but the session parameter is then a
lie on six of the nine session members. The bag keeps each signature honest.

### D2 — the run event type moves unchanged

`RunProvenanceEvent` moves from `workflows/execute-analysis.ts:223` into
`src/provenance/seam.ts`. The payloads do not change, and the barrel keeps
the export name. Thus a consumer of the type compiles unchanged.

### D3 — the block kind comes from the documents at hand

Every block site reads the kind from the documents that `land` already
holds, through the one block lookup of the draft operations. The add, the
change, and the move read the next document. The remove reads the previous
document, because the next one holds no removed block. On a change, the
event thus records the kind after the act, because a kind change is
permitted (`authoring-tools.ts:679`). The payload is not the source, because
its kind field is unvalidated text and the landed document holds the typed
truth.

### D4 — the event member names stay

`create-session`, `add-block`, and the rest keep their strings. The rename
lands on the types and the module, not on the wire. This keeps the embedder
mapping small and the diff readable.

### D5 — one total guard for the session emit

`bindSessionEmit` replaces `bindReportObservation`, with the same contract:
an unbound seam gives a call that does nothing, and a throw lands in the log,
never in the caller. The run emit keeps its guard in the workflow
(`execute-analysis.ts:386`), and that guard reads the seam member.

## Risks / Trade-offs

- [A deps rename misses a site] → The compiler finds every site, because the
  old dep names go away in the same change.
- [The block-kind read adds a document walk] → The acts land at agent speed,
  one for each tool call, thus one lookup by id costs nothing.

## Migration Plan

The embedder change is separate. Until the embedder binds the new seam, every
member is absent, and each duty degrades to its absence behavior.

## Open Questions

None.
