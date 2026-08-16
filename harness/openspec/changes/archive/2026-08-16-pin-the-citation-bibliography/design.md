# Design: pin-the-citation-bibliography

## Context

`collectCitationKeys` (`src/report-model/pin-snapshot.ts:166`) reads the synthesis records and keeps `pmid:` keys as `string[]`. The snapshot type carries `citations?: string[]` (`src/report-model/reference-resolver.ts:47`), and the membership check of a citation reference reads that list. `renderCitation` (`src/report-render/views/values.tsx:296`) renders the marker and the note alone, through the shared ledger. The appendix prints the bare key (`src/report-render/views/references-view.tsx:81`).

## Decisions

### D1: The records ride a parallel optional map, and the key list stays

The snapshot gains `citationRecords?: Record<key, { citation: string; description?: string }>`. The key list keeps the membership role, thus the resolver, the gate, and every stored pin change nothing. A legacy pin has no map, and each reader falls back to the bare key. A dual-shape key list would instead thread a union through the membership checks for no gain.

### D2: The collection keeps the first record for a key

The synthesis `keyReferences` carry the curated descriptions, and the per-finding references name the same PMIDs again with narrower relevance text. The collection walks the key references first, thus the richer record wins, and a later duplicate never overwrites. The dedupe and the code-unit sort of the keys stay as they are.

### D3: The card is the bibliography entry

The citation card renders: the bracket marker of the citation ladder, the short citation, the note, and the key. A `pmid:` key also renders a PubMed link, built as `https://pubmed.ncbi.nlm.nih.gov/<id>/`. The link is deterministic, and a navigation loads nothing into the page, thus the stand-alone rule holds. A key of another identifier space renders with no link.

### D4: The citation ladder splits from the artifact ladder

The ledger numbers citations in their own sequence, and the marker renders in brackets, `[1]`. The artifact footnotes keep the numeric superscript ladder. Thus the prose footnotes point at the provenance appendix, and the bracket markers point at the reference list, exactly as a paper reads. The appendix keeps one citation entry for each cited key, with the short citation beside it.

### D5: The listing carries the citation, not the description

The listing result gives `{ key, citation? }` entries in place of the bare key strings. The description stays out, because the listing is an orientation surface and the description pads every turn. The tool description names the change of shape, and the result is never stored, thus no compatibility arm exists.

## Risks / Trade-offs

- A synthesis with no `citation` text gives a record-less key, and the card falls back to the bare key. That is the honest floor, and the absence rule covers it.
- The bracket ladder changes the look of a stored document's citation markers at the next render. The change is the point of the finding, and no recorded page mutates.
