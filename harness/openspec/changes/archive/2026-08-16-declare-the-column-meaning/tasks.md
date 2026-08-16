# Tasks: declare-the-column-meaning

## 1. The contract

- [x] 1.1 Add `columnMeanings` and `columnLabels` to `ArtifactTableReferenceSchema` in `src/contracts/report-reference.ts`, both optional records, with field descriptions that teach the declaration.
- [x] 1.2 Export the meaning enum as a named schema, thus the renderer reads one closed set.

## 2. The kind resolution

- [x] 2.1 Add the meaning-to-kind map beside the number helper in `src/report-render/number-format.ts`, with the demoted-guess comment on the token set.
- [x] 2.2 Thread the declared meaning into the kind resolution where a table binding is in scope: the table view and the chart derivation. A metric keeps the guess, because a value locator declares nothing.

## 3. The display label

- [x] 3.1 The table header shows the declared label, with the raw column name in the `title` attribute of the header. An undeclared header prettifies: underscores become spaces, with the raw name on hover when the two differ.
- [x] 3.2 The chart axis title reads the declared label of the channel column, and the derivation stays deterministic.

## 4. The proof

- [x] 4.1 A test renders a declared `p-value` column whose name matches no token, and the cell is scientific.
- [x] 4.2 A test renders a labeled header with the raw name on hover, and a labeled axis title.
- [x] 4.3 A test renders a stray declaration key, and nothing changes.
- [x] 4.4 Run the targeted suites of the touched modules, and `tsc -p tsconfig.json`.
