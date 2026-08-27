# Design — add-report-lineage

## Context

A `Reference` pins an artifact with `path` and `hash`
(`src/contracts/report-reference.ts:32-37`). The signed provenance document is
CLI-owned, and the harness is tsprov-free by contract
(`cli/openspec/specs/prov-harness-bridge/spec.md:70`). The `emitProvenance`
seam already carries run events to the embedder, fire-and-forget
(`src/workflows/execute-analysis.ts:200-201`). The rendered page stands alone,
offline (`openspec/specs/report-render/spec.md:461`), and it opens on `file://`
(`src/tools/report-session/examine-page.ts:9-19`).

tsprov holds the walk: `ProvGraph`, `provToGraph`, attribute `resolve`, and
`lineage()` with a `backward` direction, a `dataflow` profile, and a depth cap
(`tsprov/packages/tsprov/src/graph/lineage.ts`, `graph/resolve.ts`).
prov-kernel adds dialect classification on top, not the walk itself.

## Goals / Non-Goals

**Goals:**

- The report actions land as events in the same CLI-owned analysis document.
- The page carries the frozen document copy and shows the chain of each
  grounded block in a popover.
- The harness stays free of every provenance API.

**Non-Goals:**

- No provenance document in the harness, no signer seam, and no stored bundle.
- No change to the version store, the record gate, or the session state.
- No CLI navigation work and no hosted serving (#312, #342).

## Decisions

### D1 — The events ride an observation seam into the analysis document

The report session emits typed report observation events through a new
optional seam, fire-and-forget, like `emitProvenance`. The vocabulary covers:
add, change, remove, and move a block, set the title, run a derivation,
preview the page, and record a version. Each event carries the analysis id,
the thread id, and its own data. The set-title event targets the document, not
a block. The embedder records the events into the same analysis document.

Alternative: a session provenance document built in the harness, with a signer
seam. Rejected. It pulls the provenance format into the harness, and it makes
a second signed artifact where one document serves.

### D2 — The document exports as a script data asset

A second optional seam gives the current document bytes and the attestation
bytes, opaque to the harness. The preview writes them as content-addressed
script assets that register one page global, the same as the table payloads
(`src/report-render/table-data.ts:30,172-178`). A `fetch` of a local JSON
fails on `file://`, thus a script asset is the only offline-safe carrier. The
sweep keeps the assets, because the run staged them
(`src/tools/report-session/preview-report.ts:424-425`). A publish copies the
page assets whole, thus the frozen copy rides with every published version.

Alternative: the CLI writes the document beside the page. Rejected. The sweep
deletes each file in `assets/` that the run did not stage
(`preview-report.ts:443-459`), and a second writer races the preview.

### D3 — The two seams are independent

Events without export still record into the CLI document. Export without
events still shows the chains of the analysis. Thus no pair rule and no
assembly check exists. Absence of a seam is a normal condition: no document
asset, no popover, and the page stays valid.

### D4 — The walk runs in the page, on tsprov

A tsprov-family browser library ships in `deps/` through the asset manifest
(`src/report-render/assets.ts:136-144`), as static bytes only. The harness
imports no API from it. The library reads the document, and it builds the graph
one time on first use. It resolves a node by the pin attributes, and it walks
backward with the `dataflow` profile. The depth rides the library cap, and the popover
shows a truncated chain with an explicit mark.

Alternative: compute the chains in the harness at record time. Rejected. It
needs a provenance reader in the harness, and the exported document already
holds everything the reader needs at view time.

### D5 — The renderer stamps keys, and the popover stays honest

Each grounded block carries its block id and its reference pin `(path, hash)`
as data attributes. Today only three kinds carry an id
(`src/report-render/views/prose.tsx:111`, `views/chart-view.tsx:41`,
`views/values.tsx:257`). A small boot script opens one popover beside the
reference marker, at most one at a time. A citation block shows the external
record. A pin with no node in the document shows the last hop, with an
explicit absence mark. The popover hides in print and obeys reduced motion.

## Risks / Trade-offs

- [The document can be large] → The asset is content-addressed, written once
  for each distinct document. The graph builds lazily, on the first popover.
- [Two walk engines exist overall: tsprov `lineage()` and prov-kernel
  `computeLineage`] → The page uses the format owner's engine. The kernel
  read model serves the CLI command, and the split predates this change.
- [The page ships the provenance of the whole analysis] → Accepted locally.
  A hosted publish gets a scope decision in its own change (#342).
- [The report events change the document that a running `prov verify` reads] →
  The recorder owns the write path today, and the event family lands there.

## Migration Plan

Additive and dormant. Without the two bound seams, no user sees a change. The
tsprov view library and the cli recorder events land as separate changes in
their own trees. The harness change merges alone.

## Open Questions

- The exact event fields of the report family. They land with the recorder
  change in the cli tree, and the harness seam types are the contract.
