## Context

The block contract (`src/contracts/report-blocks.ts`) defines a valid report as a strict, recursive block tree. The mechanical validator (`src/report-model/validate.ts`) checks a whole document. The structural tier (`src/report-model/structural-validation.ts`) answers membership, identity, and the file type from the snapshot alone, and its header names authoring as its purpose: an operation can run it on each change.

No code produces a document. An agent needs operations that compose a document one block at a time, and that change one block in place. Each block carries a stable `id`, thus "use a pie chart in place of a donut chart for X" is one field change on one block.

## Goals / Non-Goals

**Goals:**

- A draft model that grows from empty into a valid `ReportDocument`.
- The operations: add a block, change a block by its id, remove a block, move a block.
- Per-operation validation: the content grammar, the unique ids, and the structural resolution of each reference.
- A typed refusal in the ok channel. An operation never throws for an expected outcome.
- A read-back surface that keeps the full tree out of the agent context.
- A finish operation that reports the completeness gaps of the draft.

**Non-Goals:**

- The agent that calls the tools (#225).
- The render of a document (#307).
- The persistence of a draft or a version (#308).
- The value tier of resolution. No operation opens a file (#310 realizes the value tier).
- A change to the requirements of `report-block-model`, `report-grounding`, or `report-snapshot`.

## Decisions

### D1. An edit refuses what is wrong. The finish refuses what is missing.

`ReportDocumentSchema` refuses an empty document, and a section refuses zero children. But authoring starts from nothing. Thus the draft permits an empty section list and an empty section, and each operation validates only the properties that an edit can break: the grammar of the incoming block, the uniqueness of each id, and the structural resolution of each incoming reference. The completeness rules gate one time, in the finish operation.

The alternative was a rule that each section always holds one block. Then the remove of a last child needs a refusal. The bootstrap needs a compound first operation, and a restructure forces an order on the agent. The gate at the finish keeps each operation local and simple.

### D2. The draft grammar composes from the contract. It is not a second grammar.

The draft needs a section schema that permits zero children. A hand-copied schema drifts from the contract. Thus `src/contracts/report-blocks.ts` gains named exports for the seven atom schemas, and the draft module builds its own recursive union from them: the same atoms, and a relaxed section. The relaxation lives in one place, and the atoms have one definition.

The export is additive. It changes no requirement of the block model.

### D3. The operations are a pure core. The tools are a thin wrapper.

`src/report-model/draft.ts` holds the draft type and the pure operations: `(draft, operation, snapshot) -> Result<draft, DraftRefusal>`. The functions mutate nothing, and they return a new draft. The tool layer (`src/tools/report-authoring/`) closes over a mutable draft holder and the snapshot, applies an operation, and swaps the holder on an ok. Thus the core tests run without a tool context, and #308 later persists the same draft value.

### D4. A destination is an anchor, not an index.

Add and move take a destination: a parent (`parentId`, or the root when absent), and a place (`start`, `end`, `before: id`, or `after: id`). The default place is `end`. An index breaks when the tree changes under the agent, but an anchor id stays stable. The root holds sections only, thus an atom at the root refuses on grammar. A move of a section into its own subtree refuses as a cycle.

### D5. A change replaces an atom, and it retitles a section.

A change on an atom takes a full atom payload and keeps the id. A kind change is permitted, because the payload validates as a whole. Thus "turn this table into a chart" is one change. A change on a section takes a title only. The children of a section change through their own ids. Thus a section payload never carries a child tree, and the agent does not send a subtree that it does not hold.

### D6. Per-operation validation covers the delta. The finish covers the whole.

An operation validates the incoming payload and the properties that the edit touches. The references that landed before stay valid, because each landing gated them, and the snapshot does not change under a draft. The finish operation validates the whole draft one time: the full document schema, the unique ids, and the structural tier over every reference. The value tier stays out. It runs one time for each version, in the gate of #310.

### D7. A landed operation returns the fresh outline.

The outline is the working view of the agent: for each block, the id, the kind, the nesting, and a short label (a title, a metric label, or a clipped prose head). It carries no binding and no full prose. A read of one block by id returns the full block. Thus the agent holds the outline, and it pulls a block only when it needs one.

### D8. The refusal is a closed enum with a detail.

`DraftRefusal` carries a `reason` from a closed set, and a prose `detail`. The set is: `malformed-block`, `duplicate-id`, `unknown-target`, `unresolved-reference`, `cycle`, `atom-at-root`, `not-a-section`, and `payload-kind-mismatch`. A refusal for resolution also carries the unresolved references. The tool returns it in the ok channel as `{ applied: false, refusal }`, and a landed operation returns `{ applied: true, outline }`. This obeys the tool error contract: an expected outcome is data, and the err channel stays for an unexpected failure.

## Risks / Trade-offs

- [The draft grammar drifts from the contract] → D2 composes the draft union from the exported atom schemas. Only the section relaxation is new code.
- [A whole-draft id scan on each operation grows with the document] → the scan is in-memory and linear. A report holds hundreds of blocks at most. Measure only if a real draft shows a cost.
- [A clipped outline label hides what a block says] → the label is advisory. The full block stays one read away by id.
- [Two documents share a block id space only per draft] → uniqueness is a per-draft rule, the same scope as the validator's rule.

## Migration Plan

The work is additive and dormant. No roster changes, and `src/index.ts` exports none of it. The old report path stays live. A revert is one commit.

## Open Questions

- None. The tool ids and the exact outline label lengths are implementation details for the tasks phase.
