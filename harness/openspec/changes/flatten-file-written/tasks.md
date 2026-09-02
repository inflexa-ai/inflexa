# Tasks

## 1. The record

- [x] 1.1 Give the file-tool producer schema `invocationId`, and remove
  `timestamp`.
- [x] 1.2 Give `ArtifactRecord` `invocationId`, and remove `timestamp`.
- [x] 1.3 Build the producer record from the invocation id in
  `recordFileToolWrite`.

## 2. The seam

- [x] 2.1 Give `WorkspaceMutator.writeFile` the `invocationId` argument.
- [x] 2.2 Forward the invocation id into the collector record in the
  step-scoped realization.
- [x] 2.3 Put the invocation id on the `write-file` session event in the
  session-scoped realization.
- [x] 2.4 Give the `write-file` member of `SessionProvenanceEvent` the
  `invocationId` field.

## 3. The tools

- [x] 3.1 Pass `ctx.invocationId` from `write_file`.
- [x] 3.2 Pass `ctx.invocationId` from `edit_file`.

## 4. The tests

- [x] 4.1 Assert that the invocation id reaches the collector record, from
  the seam and from the tool path.
- [x] 4.2 Assert that the invocation id reaches the `write-file` session
  event, from the seam and from the tool path.
