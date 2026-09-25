# Tasks

Each task names its proof. No task runs inflexa or calls a product LLM.

## 1. The data (X1)

- [x] 1.1 Extend `scripts/gallery-data.sh` and the derivation scripts with the new tables of E7. Record each in the manifest. Proof: the script run and the byte check.

## 2. The trees and the grammar (X2, first)

- [x] 2.1 Add the presets `upset`, `sankey`, and `locuszoom` to the chart type enum. Add `trees` to the chart block (E1). Extend the readers of `metric`, `color`, `label`, and `track` to `locuszoom`. Write the teaching text of each member. Proof: parse tests.
- [x] 2.2 Walk, check, and resolve the tree slots `tree:x` and `tree:y` in the structural tier, the preview, and the record gate. Bridge the tree tables into the render value. Proof: block-walk, resolution, and preview tests.
- [x] 2.3 Draw the dendrograms of the heatmap (E1), with the leaf order and each refusal. Proof: heatmap tests on the pasilla trees.
- [x] 2.4 Write the `report-block-model`, `report-value-resolution`, and dendrogram requirements.

## 3. The UpSet plot and the Sankey diagram (X3)

- [x] 3.1 `figures/upset.ts` (E2). Proof: tests on the LAML membership table.
- [x] 3.2 `figures/sankey.ts` (E3). Proof: tests on the LAML flow table.
- [x] 3.3 Write their requirements.

## 4. The regional association plot (X4)

- [x] 4.1 `figures/locuszoom.ts` (E4). Proof: tests on the FTO tables.
- [x] 4.2 Write its requirement.

## 5. The hybrid export and the toolbox (X5)

- [x] 5.1 The hybrid SVG of a dense chart (E5). Proof: a unit test of the pure composition, and a headless capture of a click on the Manhattan plot.
- [x] 5.2 The toolbox (E6), and the export row retires. Proof: page tests, the validity gate, and a headless capture of each menu entry.
- [x] 5.3 Write their requirements.
- [x] 5.4 Place the names of the volcano and the Manhattan plot in the frame of each render. Let the runtime hide an overlapped name on a narrow page. Write the two modified requirements. Proof: the volcano and Manhattan tests of the names in each frame.

## 6. The gallery and the prompt (X6)

- [x] 6.1 Add the gallery uses of E7, and extend the gallery test. Proof: the gallery test with the data.
- [x] 6.2 Update the prompt if a new preset needs a word. Proof: the prompt tests.

## 7. The proof of the whole

- [x] 7.1 Render and capture the gallery, and compare each new figure with its canonical design.
- [x] 7.2 Run the blind authoring test with a GLM model on the new uses.
- [x] 7.3 Run `tsc`, the lint, and the full test suite one time. Validate the specs.
