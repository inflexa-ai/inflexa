## Why

The block contract and its validator landed with no producer. A valid report is definable, but no code lets an agent compose one or change one. This change is the join between the contract and an author, and it is the step that #305 tracks.

## What Changes

- Add a draft model for a report document under composition. A draft can be empty, and it can grow one block at a time. The completeness rules of `ReportDocumentSchema` gate at the finish, not at each edit.
- Add the authoring operations on a draft: add a block, change a block by its id, remove a block, and move a block.
- Each operation validates the result before the change lands. The validation covers the content grammar, the unique block ids, and the structural resolution of each reference against the pinned snapshot.
- A refused operation returns typed data in the ok channel. It does not throw. Thus the agent reads the reason, and then it tries again.
- Add a read-back surface: an outline of the draft, and one block by its id. The agent inspects the draft, and it does not keep the full tree in its context.
- Add a finish operation that validates the draft against the full document schema, and reports the completeness gaps.
- Package the operations as harness tools with `defineTool`, behind a factory that closes over the draft holder, the snapshot, and no other state.

## Capabilities

### New Capabilities

- `report-authoring`: the draft model of a report document under composition, the operations that change it, the per-operation validation, the typed refusal, and the read-back surface.

### Modified Capabilities

<!-- none — the block model, the grounding contract, and the snapshot keep their requirements -->

## Impact

- New code under `harness/src/report-model/` for the draft and the operations, and under `harness/src/tools/report-authoring/` for the tool layer.
- `src/contracts/report-blocks.ts` gains named exports for the seven atom schemas. No schema changes.
- The work is additive and dormant. No agent roster changes, and `src/index.ts` exports none of it. The old report path stays live and untouched.
- Reads the structural tier (`validateReferenceStructure`) and the snapshot model from #306. The value tier stays a seam, and no operation reads a file.
- No new dependency.
