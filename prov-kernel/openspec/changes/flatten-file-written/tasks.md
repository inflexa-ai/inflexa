# Tasks

## 1. The value types

- [x] 1.1 Add `ProvCallRef` to `src/types.ts`, with `invocationId`, `tool`,
  and the optional `threadId`.
- [x] 1.2 Delete `ProvSessionFileWriteRef`, and remove the `file_tool` arm
  from `ProvCommandRef`. Keep the `kind: "command"` literal.
- [x] 1.3 Export `ProvCallRef` from `src/index.ts`.

## 2. The union and the switch

- [x] 2.1 Give `file_written` the `model` field, the `call` generation arm,
  the optional `call` ref, and the optional `step` ref.
- [x] 2.2 Delete `session_file_written` from the union and from the switch.
- [x] 2.3 In `applyProvEvent`, reject a `step` generation with no step ref.
  Reject a `call` generation with no call ref.

## 3. The builders

- [x] 3.1 Write `appendFileWritten` again with three arms. Keep the
  `command` arm and the `step` arm byte-identical to the old statements.
- [x] 3.2 In the `call` arm, append the deterministic call activity, the
  actor association, and the model-agent statements. If a step ref is
  present, add the step edge.
- [x] 3.3 Draw the generation edge of the `call` arm under the shared
  `gen-{fileDigest}` id.
- [x] 3.4 Delete `appendSessionFileWritten`, and delete the `file_tool`
  branches in `appendCommandExecuted`.

## 4. The read model

- [x] 4.1 Classify a `call-` prefixed activity as a `file_tool` activity in
  the QName fallback.
- [x] 4.2 Surface `invocationId` on the activity node.

## 5. The contract

- [x] 5.1 State the call activity, the call digest, and the three
  `file_written` arms in `SPEC.md`. Remove the `session_file_written`
  section.
- [x] 5.2 Regenerate the golden fixture with the three generation arms, on
  purpose.
- [x] 5.3 Extend `events.test.ts` with the call arms and with the two
  rejection cases. Extend `lineage.test.ts` with the call classification and
  with a legacy-shape document.
