# Flatten the file-written event, and retire the file-tool command arm

## Why

The dialect records one file-tool write with two shapes. A step-scoped write
rides a pseudo-command group. A session write rides a lifecycle action with a
fresh random id. The two shapes duplicate the format, and the random id does
not dedupe under a durable replay. One deterministic call activity replaces
both shapes.

## What Changes

- The `file_written` event gains `model` and the `call` generation arm. The
  `step` ref becomes optional, and the event gains an optional `call` ref.
- `applyProvEvent` rejects a `step` generation with no step ref. It rejects a
  `call` generation with no call ref.
- The `call` arm appends a deterministic call activity,
  `inflexa:call-{callDigest}`. The digest mixes the invocation id with a
  scope disambiguator: the step key, or else the thread.
- The call activity keeps the type `inflexa:FileToolWrite`. It carries
  `inflexa:tool`, `inflexa:invocationId`, and the optional
  `inflexa:threadId`. It carries no formal time.
- The `file_tool` arm of `ProvCommandRef` is removed. The
  `session_file_written` event and `ProvSessionFileWriteRef` are removed. The
  `kind: "command"` discriminator literal stays for wire stability.
- The lineage read model classifies a call activity as a `file_tool`
  activity, and it surfaces `invocationId` on the activity node. A stored
  document with the old shapes classifies as before.
- `SPEC.md` states the new rules, and the golden fixture covers the three
  generation arms.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `prov-kernel`: the core union loses `session_file_written`, and
  `file_written` carries the generation authority for all three arms. The
  call activity becomes part of the dialect and of the wire format.

## Impact

- `src/types.ts`: `ProvCallRef` replaces `ProvSessionFileWriteRef`, and
  `ProvCommandRef` keeps one variant.
- `src/events.ts`: the union and the switch.
- `src/document.ts`: `appendFileWritten` with three arms, and the removal of
  `appendSessionFileWritten`.
- `src/lineage.ts`: the `call-` prefix fallback and the `invocationId` field.
- `SPEC.md` and the golden fixture.
- The package version stays `0.7.0`, because `0.7.0` is not published. No
  compatibility shim exists on the write side.
