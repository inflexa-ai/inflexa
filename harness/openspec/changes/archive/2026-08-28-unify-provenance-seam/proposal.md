# Unify the provenance seam

## Why

The review of PR #467 rejects the standalone report seam pair. The harness
declares three provenance duties today in three places: the run emit on the
workflow deps, the report observation seam, and the document source seam. One
surface must carry the three, because they answer one host concern.

## What Changes

- Delete `tools/report-observation.ts` and `tools/report-provenance.ts` as
  standalone seams.
- Declare `ProvenanceSeam` in `src/provenance/seam.ts`, with three optional
  members: `emitRunEvent`, `emitSessionEvent`, and `readExport`.
- Move `RunProvenanceEvent` into the module, unchanged.
- Carry the one seam through the deps bags. The emit sites keep their events,
  and only the import and the member name change.
- Add `blockKind` to the four block events.
- Keep the guard behavior: absence is a no-op, and a throw lands in the log.

## Capabilities

### New Capabilities

- `provenance-seam`: the one provenance surface of the harness. It covers the
  run emit, the session emit, the document read, and the page-asset export.

### Modified Capabilities

- `run-observation-seam`: the independence rule names the seam member, not
  the retired `emitProvenance` dep.

### Removed Capabilities

- `report-observation-seam`: folds into `provenance-seam`.
- `report-provenance-export`: folds into `provenance-seam`.

## Impact

- `src/provenance/seam.ts` is new. The two seam files under `tools/` go away.
- `src/agents/conversation-agent.ts`, `src/app/chat-turn.ts`,
  `src/app/spawn-report-session.ts`, the report tools, and
  `src/workflows/execute-analysis.ts` take the one seam through their deps.
- `src/index.ts` exports the seam and its event types.
- The embedder binds one object at its composition root, in its own change.
