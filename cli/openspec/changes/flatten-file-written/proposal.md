# Flatten the file-written bus event, and retire the file-tool command arm

## Why

The kernel now records a file-tool write as one deterministic call activity.
The bus carried two shapes for the same fact: a `file_tool` pseudo-command
group, and the `prov.session_file_written` member. One flattened
`prov.file_written` event replaces both, and the recorder maps it through
the kernel unchanged.

## What Changes

- `prov.file_written` gains `model`, the `call` generation arm, an optional
  `call` ref, and an optional `step` ref. `prov.session_file_written` is
  removed.
- `ProvCommandRef` keeps one variant, `kind: "command"`. The bridge stops
  emitting `prov.command_executed` for a file-tool producer group.
- A file-tool producer group emits `prov.file_written` with
  `generation: "call"` and `call: { invocationId, tool }`, beside the step
  ref. The invocation id comes from the collector record.
- The session `write-file` seam event maps onto the same flattened member,
  with the thread id on the call ref and no step ref.
- The command-output and leaf file events gain `model`, from the
  construction-time model id of the registry.
- The lineage command renders the old pseudo-command shape and the new call
  shape with one `file_tool` classification.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `prov-run-events`: the flattened `prov.file_written` shape, and the
  one-variant `ProvCommandRef`.
- `prov-harness-bridge`: the file-tool group emission, and the session
  `write-file` mapping.

## Impact

- `src/types/prov.ts`, `src/types/events.ts`, `src/lib/bus.ts`: the bus
  contract and the telemetry projection.
- `src/modules/harness/prov_bridge.ts`: the registry emission and the
  session emit.
- `src/modules/prov/lineage.ts`: no change. The kernel read model carries
  the classification, and the tests cover a mixed-shape document.
