# Tasks: chain-and-prune-the-derivations

## 1. The appendix chain

- [x] 1.1 The table and the chart mark their bindings in the provenance ledger, and the cards show the markers.
- [x] 1.2 The derivation records ride the render call, and the appendix entry of a derived path adds the chain line.

## 2. The finish warning

- [x] 2.1 The finish lists each unused derivation as an advisory warning that names the output path.

## 3. The record prune

- [x] 3.1 The record removes the output file of each unused derivation, under the session `derived/` directory alone.
- [x] 3.2 A failed removal logs and changes no outcome.

## 4. The proof

- [x] 4.1 Tests cover the seven delta scenarios across the three deltas.
- [x] 4.2 A document with no derivation and a session with none prune nothing and warn nothing.
- [x] 4.3 Run the targeted suites of the touched modules, and `tsc -p tsconfig.json`.
