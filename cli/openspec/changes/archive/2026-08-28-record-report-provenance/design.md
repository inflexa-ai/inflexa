# Design — record-report-provenance

## Context

The harness declares one `ProvenanceSeam` with three optional members: the
run emit, the session emit, and the document read. The session union carries
nine members, the creation member carries `sessionKind` and `parentThreadId`,
and the four block members carry `blockKind`.

The recorder is kernel-first: `applyProvEvent` is the sole producer of core
statements, and `toKernelEvent` makes a missing kernel counterpart a compile
error (`src/modules/prov/prov.ts`). Kernel `0.6.0` carries the session and
report members in its core union, thus the recorder needs no extension door
for this family. The export pair exists as library functions:
`getAnalysisProvenance` (`src/db/primary_query.ts`) and `buildAttestation`
(`src/modules/prov/verify.ts:64`).

## Goals / Non-Goals

**Goals:**

- Every report act lands in the same signed document as the analysis events.
- The report page gets the current document bytes and the attestation.
- One bridge module realizes the whole seam, with no new command surface.

**Non-Goals:**

- No host-side mapping. The kernel owns the event-to-statements mapping.
- No change to the flush, the chain hash, or the signing path.
- No TUI surface for the report events.

## Decisions

### D1 — Nine bus members, one for each act

The family mirrors the seam union: `prov.session_created`,
`prov.report_block_added`, `prov.report_block_changed`,
`prov.report_block_removed`, `prov.report_block_moved`,
`prov.report_title_set`, `prov.report_derivation_run`,
`prov.report_previewed`, `prov.report_version_recorded`. Each member carries
`analysisId`, `actor`, `model`, and one payload ref. The creation member
records both session kinds, and the kind rides the payload. The
one-event-per-action rule holds: one act, one member.

### D2 — The ref types are kernel re-exports

The payload refs come from `@inflexa-ai/prov-kernel`, re-exported through
`src/types/prov.ts` like the core refs. The kernel owns the dialect, thus it
owns the shapes. The earlier cli-owned copies go away. A widened kernel shape
reaches the bus contract on purpose, through the pin bump, never silently.

### D3 — The recorder is uniform

`onEvent` sends every prov member through `toKernelEvent` and
`applyProvEvent`. The report branch, `appendReportRecords`, and the helper
set go away. `toKernelEvent` gains the nine arms, thus the kernel
exhaustiveness guard covers the whole family. The first-declaration guards
live in the kernel arms, and they close the double-emit race of
`prepareChatTurn`.

### D4 — The actor is the agent: the system actor, with the model on its behalf

The agent does the changes, thus the record names the agent. The AI rides as
its own `inflexa:Model` software agent on behalf of the responsible agent, as
in the step records. Thus every report member stamps `systemActor()` and
carries `model: ProvModelId`. The model is the one that drives the session at
emit time, refreshed on an agent switch. Alternative: the user actor on each
act. Rejected, because the user does not do the acts.

### D5 — One bridge realizes the whole seam

`src/modules/harness/prov_bridge.ts` realizes the three members, and
`report_bridge.ts` folds into it. The composition root binds one
`ProvenanceSeam` object on the core bag
(`src/modules/harness/runtime.ts:1163-1173`). The run emit keeps the
swappable construction-time model stamp behind the idle gate of the agent
switch. The session emit reads the live model at each act, because a session
act must name the model at act time. The two mechanisms stay different on
purpose.

### D6 — The document read drains the flush first

The read member awaits `flushProvenanceAsync()`
(`src/modules/prov/prov.ts`), then reads the provenance column directly with
`getAnalysisProvenance`, then builds the attestation with `buildAttestation`.
The direct read is deliberate: `serializeProvenance` seeds a fresh document
on a null column, and fresh bytes carry no signature. The column read is the
absence test and the exact signed bytes, in one query. A null column and a
vanished row both give absence, in-band.

## Risks / Trade-offs

- [The kernel pin and the code must move together] → The pin bump and the
  recorder rework land in one commit.
- [A mid-session read races the debounced flush] → The drain in D6 closes
  the race. The cost is one flush await for each preview.
- [A byte drift against the removed host mapping] → The recorder fixture
  tests pin the flushed document state, and they run against the kernel arms
  unchanged.

## Migration Plan

Additive and dormant until the composition binds the seam, which this change
does. Old documents gain report records only for new acts. No backfill.

## Open Questions

None. The kernel union fixes the event vocabulary.
