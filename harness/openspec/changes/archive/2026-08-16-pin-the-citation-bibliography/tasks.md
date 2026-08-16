# Tasks: pin-the-citation-bibliography

## 1. The pin

- [x] 1.1 The snapshot type gains `citationRecords`, an optional map from the key to `{ citation, description? }` (`src/report-model/reference-resolver.ts`).
- [x] 1.2 The collection stores the record beside the key, key references first, first record wins (`src/report-model/pin-snapshot.ts`).

## 2. The render

- [x] 2.1 The citation card renders the short citation, the note, the key, and the PubMed link of a `pmid:` key.
- [x] 2.2 The citation markers number in their own bracket ladder, and the artifact footnotes keep the numeric ladder (`src/report-render/references.ts`).
- [x] 2.3 The appendix citation entry shows the short citation beside the key when the record exists.

## 3. The listing

- [x] 3.1 The listing gives `{ key, citation? }` entries, and its description names the shape (`src/tools/report-session/list-artifacts.ts`).

## 4. The proof

- [x] 4.1 A pin test stores the record, keeps the first for a duplicate key, and loads a legacy pin with no map.
- [x] 4.2 A render test covers the bibliography card, the record-less fallback, and the two split ladders.
- [x] 4.3 A listing test covers the citation beside the key.
- [x] 4.4 Run the targeted suites of the touched modules, and `tsc -p tsconfig.json`.
