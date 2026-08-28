# Tasks — shape-the-lineage-chain

## 1. The chain builder

- [x] 1.1 Build the rail from the walk edges in the popover script, with a cycle guard
- [x] 1.2 Read the command label, the step, and the script from the node attributes
- [x] 1.3 Collapse the other outputs of a command behind one count row
- [x] 1.4 Keep the absence mark and the truncation mark on the new rail

## 2. The control and the anatomy

- [x] 2.1 Draw the branch glyph as an inline stroke SVG in the shared marker emission point
- [x] 2.2 Build the popover markup: the header, the row forms, the connector labels, the footer
- [x] 2.3 Add the scroll cap, the print rule, and the reduced-motion rule
- [x] 2.4 Add the CSS classes with tokens, each with an emitting view

## 3. The paths and the placement

- [x] 3.1 Drop the shared run prefix from the row paths, and put the full path on the hover
- [x] 3.2 Size the popover to its longest row, up to a viewport cap
- [x] 3.3 In a narrow window, cut a long tail at its start and an over-long name in its middle
- [x] 3.4 Place the popover below the control, flip above on short space, and never cover the control

## 4. Coverage

- [x] 4.1 Extend the fixture: a two-hop chain, off-chain outputs, and one long sibling pair
- [x] 4.2 Extend the render tests, and keep the validity gate green
- [x] 4.3 Drive the fixture page at a normal width and at a narrow width

## 5. Verification

- [x] 5.1 Run `tsc -p tsconfig.json`, and run the targeted test files
- [x] 5.2 Run `bun run format:file` on the changed files, and rebuild the dist
