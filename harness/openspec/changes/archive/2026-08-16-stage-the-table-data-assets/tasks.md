# Tasks: stage-the-table-data-assets

## 1. The row bound

- [x] 1.1 The whole-table binding admits the optional `rowBound` in `src/contracts/report-reference.ts`, with a description that names it as the primary size control.
- [x] 1.2 The resolution applies the bound with the numeric-aware compare, and the structural tier refuses an unknown bound column.

## 2. The payload

- [x] 2.1 The renderer derives one columnar payload for each bound table: columns, row arrays, and the first-appearance dictionary.
- [x] 2.2 The render result returns the payloads with their content-hash asset names, and the table markup holds the header and no data rows.
- [x] 2.3 The page script decodes the dictionary, and the table card holds the raw-bytes download link.

## 3. The stage

- [x] 3.1 The preview writes each payload and each sidecar in the figure pipeline.
- [x] 3.2 The stage sweeps the assets directory: what the page does not reference goes, and the manifest statics stay.

## 4. The proof

- [x] 4.1 Tests cover the nine delta scenarios across the three deltas.
- [x] 4.2 A document with no table stages no data asset, and its page stays byte-identical.
- [x] 4.3 Run the targeted suites of the touched modules, and `tsc -p tsconfig.json`.
