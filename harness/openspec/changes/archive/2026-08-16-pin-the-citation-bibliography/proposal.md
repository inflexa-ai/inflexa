# Proposal: pin-the-citation-bibliography

## Why

The References section of the session page holds no bibliography. The citation cards show only the agent's note, numbered in the same ladder as the artifact footnotes. The appendix prints `pmid:26997480` bare. No author, no year, no link. The identity exists at the source — the run synthesis carries `citation: "Hugo et al. 2016"` and a description beside each PMID — and the pin keeps the key alone.

## What Changes

- The pin stores a citation record beside each key: the short citation and the description, in an optional map keyed by the citation key. The key list stays as it is, thus the membership check and every stored pin keep working.
- The citation card renders the short citation, the note, and a PubMed link for a `pmid:` key. The link is a navigation, not a loaded resource, thus the page still stands alone.
- The literature numbering splits from the artifact footnotes. The citation cards number in their own bracket ladder, and the artifact footnotes keep the numeric ladder.
- The appendix citation entries show the short citation beside the key.
- The pinned-artifact listing tool gives the short citation beside each key, thus the agent stops the guess about which PMID is which paper.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-snapshot`: the pin collects the citation records, not the keys alone.
- `report-render`: the citation card renders the bibliography, and the citation numbering splits from the artifact ladder.
- `report-session-agent`: the listing gives the citation beside its key.

## Impact

- Affected code: `src/report-model/pin-snapshot.ts`, `src/report-model/reference-resolver.ts` (the snapshot type), `src/report-render/references.ts` and the views, `src/tools/report-session/list-artifacts.ts`, and their tests.
- A stored pin with no record map renders as today, thus no migration exists.
