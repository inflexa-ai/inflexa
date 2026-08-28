# Tasks

## 1. The seam module

- [x] 1.1 Make `src/provenance/seam.ts` with `ProvenanceSeam`,
  `SessionProvenanceEvent`, `ProvenanceExport`, and `bindSessionEmit`, per
  the sketch in `pr467-feedback-plan.md`.
- [x] 1.2 Move `RunProvenanceEvent` into the module, unchanged. Point the
  workflow imports at it.
- [x] 1.3 Delete `tools/report-observation.ts` and
  `tools/report-provenance.ts`. Update `src/index.ts`: export the seam and
  its types, and drop the retired exports.

## 2. The deps and the emit sites

- [x] 2.1 Replace `emitReportObservation` with `provenance?: ProvenanceSeam`
  on the conversation-agent deps, and thread it to the spawn.
- [x] 2.2 Replace the dep on `PrepareChatTurnDeps`, and keep the
  `create-session` emit at the thread-write site.
- [x] 2.3 Replace `emitProvenance` on `ExecuteAnalysisDeps` with the seam,
  and point the guard at the run emit member.
- [x] 2.4 Replace the document source dep of the preview with the read
  member. The staging behavior does not change.

## 3. The block kind

- [x] 3.1 Add `blockKind` to the four block events. Each site reads the kind
  from the documents that `land` holds: the previous one for a remove, the
  next one for the rest.

## 4. The checks

- [x] 4.1 Update the seam and staging tests to the new module and the new
  member names, and cover the block kind.
- [x] 4.2 Run `tsc -p tsconfig.json` and the targeted test files of the
  touched areas.
