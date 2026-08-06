## 1. The draft grammar

- [ ] 1.1 Export the seven atom schemas from `src/contracts/report-blocks.ts`. The export is additive, and no schema changes.
- [ ] 1.2 Make the draft grammar in `src/report-model/draft.ts`: a relaxed section schema, a recursive draft block union, and the draft document type. The atoms come from the contract exports.
- [ ] 1.3 Write the tests of the draft grammar: an empty draft parses, an empty section parses, a strict atom still refuses an extra field, and a nested empty section parses.

## 2. The pure operations

- [ ] 2.1 Make the operation types and the `DraftRefusal` type in `src/report-model/draft-operations.ts`. The reason set is closed: `malformed-block`, `duplicate-id`, `unknown-target`, `unresolved-reference`, `cycle`, `atom-at-root`, `not-a-section`, and `payload-kind-mismatch`.
- [ ] 2.2 Make the shared validation pipeline of one operation: parse the payload, apply to a candidate tree, scan the ids, and run the structural tier over each incoming reference. A refusal returns on the `Result` err channel of the pure core, and the draft value stays untouched.
- [ ] 2.3 Make the add operation with the anchor destination: parent id or root, and `start`, `end`, `before`, or `after`. The root admits a section only. An anchor implies its parent, and a parent that disagrees with the anchor refuses. A section payload can carry children.
- [ ] 2.4 Make the change operation: a full atom payload with the target id stamped on it, or a section title. A kind change on an atom is permitted.
- [ ] 2.5 Make the remove operation: one block by id, and a removed section takes its subtree.
- [ ] 2.6 Make the move operation with the same destination shape, the cycle guard for a section, and the refusal of a self-anchor.
- [ ] 2.7 Write the tests of each operation: one landing case and each refusal reason, with the draft unchanged after a refusal.

## 3. The read surface and the finish

- [ ] 3.1 Make the outline builder: for each block the id, the kind, the nesting, and a clipped label. No binding and no full prose.
- [ ] 3.2 Make the read of one block by id. The result carries the full block.
- [ ] 3.3 Make the finish operation: the full document schema, the id rule, and the structural tier over every reference. It reports each gap as data, it gives the `ReportDocument` value on a pass, and it changes nothing.
- [ ] 3.4 Write the tests of the outline, the single-block read, and the finish: the empty-section gap, and the passing draft.

## 4. The tool layer

- [ ] 4.1 Make the draft holder and the factory in `src/tools/report-authoring/`. The factory closes over the holder and the snapshot, and it swaps the holder only on a landed operation.
- [ ] 4.2 Make the tools with `defineTool`: `add_block`, `change_block`, `remove_block`, `move_block`, `read_outline`, `read_block`, and `finish_draft`. A refusal returns in the ok channel as `{ applied: false, refusal }`, and a landed operation returns `{ applied: true, outline }`. Each tool gives a `describeCall` hook or the literal `"none"`.
- [ ] 4.3 Write the tests of the tool layer: the ok-channel refusal envelope, the outline in a landed result, and the isolation of two factories with two drafts.

## 5. The gates

- [ ] 5.1 Run `bun run format:file` on each changed source file.
- [ ] 5.2 Run `tsc -p tsconfig.json`, and repair each finding.
- [ ] 5.3 Run the lint of the harness on the changed files, and repair each finding.
- [ ] 5.4 Run the tests of the changed areas only: `src/report-model/` and `src/tools/report-authoring/`. Do not run the full suite.
