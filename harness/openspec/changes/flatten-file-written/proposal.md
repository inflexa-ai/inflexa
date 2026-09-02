# Carry the invocation id on each file-tool write

## Why

The kernel now records a file-tool write as one deterministic call activity.
The call identifier derives from the tool-call invocation id, because that id
is replay-stable. The file-tool record and the `write-file` session event
carried a wall-clock timestamp instead, and the bridge dropped it. The
invocation id must ride the record and the event, and the timestamp must go.

## What Changes

- The file-tool producer record gains `invocationId`, and it loses
  `timestamp`.
- `WorkspaceMutator.writeFile` gains the `invocationId` argument. The two
  file tools pass the `invocationId` of their tool context.
- The step-scoped realization records the invocation id into the collector.
  The session-scoped realization puts it on the `write-file` session event.
- The `write-file` member of `SessionProvenanceEvent` gains `invocationId`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exec-provenance-lineage`: the file-tool producer record carries the
  invocation id, not a timestamp.
- `harness-workspace-tools`: the mutate seam accepts and records the
  invocation id, in the step context and in the session context.
- `provenance-seam`: the `write-file` session event carries the invocation
  id.

## Impact

- `src/provenance/types.ts`, `src/provenance/collector.ts`,
  `src/execution/artifact-record.ts`: the record shape.
- `src/tools/workspace/mutator.ts`, `write-file.ts`, `edit-file.ts`: the
  seam argument and the two tool call sites.
- `src/provenance/seam.ts`: the event shape.
