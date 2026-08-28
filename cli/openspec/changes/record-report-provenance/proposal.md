# Record report provenance

## Why

The harness emits session and report events, and it asks for the provenance
document of an analysis, through one optional provenance seam. The cli must
realize that seam, thus a report act lands in the signed document, and a
report page carries the document to walk. The review of PR #467 sets the
shape: no special report path, and the mapping lives in the kernel.

## What Changes

- The `BusEvent` union carries the report provenance family: one member for
  each observed act. The four block members carry the block kind. The
  telemetry projection covers each member.
- The payload ref types come from `@inflexa-ai/prov-kernel`, re-exported
  through `src/types/prov.ts` like the core refs.
- The recorder maps every member through `toKernelEvent` and
  `applyProvEvent`. No host-side mapping branch exists. The signing path does
  not change.
- One bridge module, `prov_bridge.ts`, realizes the whole `ProvenanceSeam`:
  the run emit, the session emit, and the document read.
- The document read drains the flush, reads the stored bytes, and builds a
  fresh attestation. Absence stays in-band.
- The composition root binds one seam object on the core bag.
- The kernel pin moves to `^0.6.0` for the new core members.

## Capabilities

### New Capabilities

<!-- None. Every behavior lands in an existing cli spec. -->

### Modified Capabilities

- `prov-run-events`: the bus contract gains the report family with the block
  kind, and the recorder maps it through the kernel dispatch.
- `prov-harness-bridge`: the one seam realization replaces the two seam
  bindings, and the wording moves to the `ProvenanceSeam` members.

## Impact

- `src/types/prov.ts`, `src/types/events.ts`, `src/lib/bus.ts` — the kernel
  re-exports, the nine bus members, and the telemetry projections.
- `src/modules/prov/prov.ts` — the report branch and its helpers go away.
- `src/modules/harness/prov_bridge.ts` — the merged bridge.
  `report_bridge.ts` goes away, and `runtime.ts` binds one object.
- `package.json` — the kernel pin.
- No new dependency. No command changes, thus the agent policy tree does not
  change.
