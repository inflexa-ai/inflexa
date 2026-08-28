# Record report provenance

## Why

The harness now emits report observation events and asks for the provenance
document of an analysis, through two optional seams. The cli binds neither
seam today. Thus a report act leaves no record in the signed document, and a
report page carries no document to walk.

## What Changes

- The `BusEvent` union gains the report provenance family. One member for each
  observed act: the session creation, the five block operations, the
  derivation, the preview, and the version record. Each member carries the
  analysis id, the actor, and the data of its act. The telemetry projection in
  `eventFields` covers each new member.
- The recorder maps the report members in the host, before the kernel
  dispatch. The session creation makes a typed session record, and a report
  session mints an `inflexa:Report` entity. The version record mints an
  `inflexa:ReportVersion` entity, attributed to the report entity. Each other
  act lands as a lifecycle action that names the thread. The signing path does
  not change.
- A new bridge module realizes `emitReportObservation` as bus emission, with
  the same shape as the run-observation bridge.
- The cli realizes `readReportProvenance`: drain the flush, then give the
  stored document bytes and a fresh attestation. Absence stays in-band.
- The composition root binds the two seams on the core bag.
- The bridge spec sentence about the harness-owned event shapes widens to the
  two new seams, and the stale one-argument callback signature is corrected.

## Capabilities

### New Capabilities

<!-- None. Every behavior lands in an existing cli spec. -->

### Modified Capabilities

- `prov-run-events`: the bus contract gains the report family, and the
  recorder maps it host-side as entities and lifecycle actions.
- `prov-harness-bridge`: the two new seam realizations, and the corrected
  wording of the harness-owned shape clause.

## Impact

- `src/types/prov.ts`, `src/types/events.ts`, `src/lib/bus.ts` — the report
  ref types, the nine bus members, and the telemetry projections.
- `src/modules/prov/prov.ts` — the host branch before `toKernelEvent`, the
  entity minting, and the lifecycle actions.
- `src/modules/harness/report_bridge.ts` (new), `src/modules/harness/runtime.ts`
  — the two realizations, bound on the core bag.
- No new dependency. The kernel and tsprov are already pinned.
- No command changes, thus the agent policy tree does not change.
