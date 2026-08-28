# Add the session and report events to the core union

## Why

The report acts of a session ride the extension door today. A host-side switch
in the cli maps them onto `appendLifecycleAction`, and it restates the internal
`appendModelAgent`. The mapping determines the document bytes, thus it is
format, and the kernel owns format. The review of inflexa PR #467 directs the
move into the core union.

## What Changes

- Extend the core `ProvEvent` union with nine members: the session start plus
  the eight report acts.
- Add one arm for each member to the `applyProvEvent` switch.
- Put the builders in the document model, over the internal
  `appendLifecycleAction` and `appendModelAgent`.
- Guard the generation edge, the attribution, and the specialization of the
  report entity and the version entity with a first-declaration guard.
- Carry `blockKind` on the four block members.
- State the report vocabulary in `SPEC.md`, and cover the new members in the
  golden fixture.
- Keep each QName, each activity type, and each attribute byte-identical to
  the historical host mapping of the cli.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `prov-kernel`: the core union grows from nine members to eighteen members.
  The extension-door rule narrows to host-specific events. The report
  vocabulary becomes part of the dialect and of the wire format.

## Impact

- `src/events.ts`: the union and the switch.
- `src/document.ts`: the builders and the guards.
- `src/types.ts`: the session and report ref value types.
- `SPEC.md` and the golden fixture.
- The package version moves past `0.5.x`. The change is additive for a
  producer, thus it is not breaking.
