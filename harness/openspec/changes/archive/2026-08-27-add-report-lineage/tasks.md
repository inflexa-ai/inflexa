# Tasks — add-report-lineage

## 1. The observation seam

- [x] 1.1 Declare the report observation event types and the optional seam
- [x] 1.2 Wire the seam through the assembly and the report session runtime
- [x] 1.3 Emit the block events from the authoring tools: add, change, remove, move, set the title
- [x] 1.4 Emit the derivation, preview, and record events from the session tools
- [x] 1.5 Make sure that a seam failure logs and never fails the action

## 2. The document export

- [x] 2.1 Declare the optional document source seam, with absence as a normal result
- [x] 2.2 Write the document and the attestation as content-addressed script assets in the preview
- [x] 2.3 Register the page global for the document, with the table-payload pattern

## 3. The renderer

- [x] 3.1 Stamp the block id and the reference pin on each grounded kind
- [x] 3.2 Add the lineage library to the asset manifest, and stage it into `deps/`
- [x] 3.3 Add the popover control, the boot script, and the one-open rule
- [x] 3.4 Add the absence mark, the truncation mark, and the citation form
- [x] 3.5 Add the popover CSS classes, each with an emitting view
- [x] 3.6 Cover the popover control in the design fixture, and render the fixture
- [x] 3.7 Extend the render tests and the validity gate coverage

## 4. Verification

- [x] 4.1 Run `tsc -p tsconfig.json`, and run the targeted test files of each changed area
- [x] 4.2 Run `bun run format:file` on each changed source file

## 5. Separate changes in other trees

- [x] 5.1 tsprov: make the lineage view library as a browser bundle package
- [ ] 5.2 cli: map the report events in the recorder, and bind the two seams
