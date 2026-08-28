# Design — record-report-provenance

## Context

The harness seam pair is published and typed: `EmitReportObservation` is a
synchronous void callback, and `ReadReportProvenance` gives
`{ document, attestation? }` or absence (`@inflexa-ai/harness`,
`dist/tools/report-observation.d.ts`, `dist/tools/report-provenance.d.ts`).
The event union carries nine members, and the creation member carries
`sessionKind` and `parentThreadId`.

The recorder is kernel-first: `applyProvEvent` is the sole producer of core
statements, and `toKernelEvent` makes a missing kernel counterpart a compile
error (`src/modules/prov/prov.ts:123-127`). The kernel model exposes
`appendLifecycleAction` for host extension records, and no cli code calls it
yet. The export pair exists as library functions: `serializeProvenance`
(`src/modules/prov/document.ts:43`) and `buildAttestation`
(`src/modules/prov/verify.ts:64`), already factored as injectable seams
(`src/tui/commands.tsx:2474-2481`).

## Goals / Non-Goals

**Goals:**

- Every report act lands in the same signed document as the analysis events.
- The report page gets the current document bytes and the attestation.
- The composition binds both seams with no new command surface.

**Non-Goals:**

- No kernel change. The report records ride the extension door.
- No change to the flush, the chain hash, or the signing path.
- No TUI surface for the report events.

## Decisions

### D1 — Nine bus members, one for each act

The family mirrors the seam union: `prov.session_created`,
`prov.report_block_added`, `prov.report_block_changed`,
`prov.report_block_removed`, `prov.report_block_moved`,
`prov.report_title_set`, `prov.report_derivation_run`,
`prov.report_previewed`, `prov.report_version_recorded`. Each member carries
`analysisId`, `actor`, and one payload ref typed in `src/types/prov.ts`. The
creation member is `prov.session_created`, because it records both session
kinds, and the kind rides the payload. The one-event-per-action rule holds:
one act, one member.

### D2 — The recorder branches the report family in the host

`onEvent` tests for the report family before `toKernelEvent`, thus the kernel
exhaustiveness guard keeps its force for the core family. The mapping writes
through the loaded document and `appendLifecycleAction`:

- `prov.session_created` records one `inflexa:CreateSession` action for both
  kinds, and the kind rides as an attribute. A conversation is a session, thus
  no second action type exists. With kind `report`, the mapping also mints an
  `inflexa:Report` entity, with the parent thread as an attribute. A cli-side
  QName over `cliProvDigest` of the thread id keys the entity.
- Each block act, the title, the derivation, and the preview land as one
  typed lifecycle action with `inflexa:threadId` and the act data.
- `prov.report_version_recorded` mints an `inflexa:ReportVersion` entity with
  the version id, attributed to the report entity of its thread.

A mapping throw logs and returns, the same as the kernel dispatch guard. The
flush, the chain hash, and the signature see nothing new.

### D3 — The actor is the agent: the system actor, with the model on its behalf

The agent does the changes, thus the record names the agent. The dialect has
no agent actor kind. The AI rides as its own `inflexa:Model` software agent
on behalf of the responsible agent, as in the step records. Thus every report
member stamps `systemActor()` and carries `model: ProvModelId`. The model is
the one that drives the session at emit time, refreshed on an agent switch.
The user steers the agent, and a later change can record the steering.
Alternative: the user actor on each act. Rejected, because the user does not
do the acts.

### D4 — The observation realization is its own bridge module

`src/modules/harness/report_bridge.ts` mirrors `run_bridge.ts`: a module that
imports the Bus itself and returns `void`. The composition root binds it on
the core bag (`src/modules/harness/runtime.ts:1163-1173`), beside the eyes
and the asset lookup. The bridge stamps the model that currently drives the
session, thus it reads the live model the way the swappable run emitters do.

### D5 — The document read drains the flush first

`readReportProvenance` awaits `flushProvenanceAsync()`
(`src/modules/prov/prov.ts:228`), then reads the provenance column directly
with `getAnalysisProvenance`, then builds the attestation with
`buildAttestation`. The direct read is deliberate: `serializeProvenance`
seeds a fresh document on a null column, and fresh bytes carry no signature.
The column read is the absence test and the exact signed bytes, in one query.
A null column and a vanished row both give absence, in-band. The realization
imports `modules/prov/` statically, because the runtime module already loads
the heavy graphs at boot. The TUI keeps its lazy route.

## Risks / Trade-offs

- [Two active changes touch the recorder] → This change builds on the kernel
  recorder as the code stands. The report branch sits before the kernel
  dispatch, thus the two changes do not rewrite the same lines.
- [A mid-session read races the debounced flush] → The drain in D5 closes the
  race. The cost is one flush await for each preview.
- [The report entity QName is cli-minted] → The kernel owns no report
  derivation today. The digest and the shape follow `cliProvDigest`, and the
  compatibility fixture pins that digest.

## Migration Plan

Additive and dormant until the composition binds the seams, which this change
does. Old documents gain report records only for new acts. No backfill.

## Open Questions

None. The event vocabulary is fixed by the harness seam types.
