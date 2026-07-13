## Why

`write_file`/`edit_file` outputs are misattributed in the signed provenance record: `ProvenanceCollector.recordFileToolWrite` exists (`src/provenance/collector.ts:223`) but has no caller, and the mutate seam discards the sandbox provenance frame its write exec returns. Every agent-authored file therefore falls into the registration leaf bucket, where the embedder's bridge attests it as `producer: "command"` with a step-grain generation edge — an actively wrong label, not just a missing one. The cli's `prov-run-events` spec already specifies the `file_tool` producer variant crossing the bus; the harness simply never produces it. Now that `prov lineage` walks the graph interactively (inf-cli#75), the misattribution is user-visible.

## What Changes

- Thread the step's `ProvenanceCollector` into the `WorkspaceMutator` seam and, on each successful confined write, record a file-tool provenance record — content hash and size computed in-process from the exact bytes written, no rehash round-trip.
- Normalize the record's output path to step-relative inside `recordFileToolWrite` (mirroring `recordCommandExecution`'s `stepPrefix` strip), so the record keys match manifest entries and the last-write-wins unlink actually fires.
- `write_file`/`edit_file` outputs then cross registration as `file_tool` producer groups; the already-built downstream pipeline (bridge `file_tool` mapping → `inflexa:FileToolWrite` activity → lineage rendering) activates with **no downstream shape changes**.
- Correct the stale docstrings naming nonexistent `append_file`/`copy_file` tools (`collector.ts`, `execution/artifact-record.ts`).

## Capabilities

### New Capabilities

_None — this closes a gap between two existing capabilities._

### Modified Capabilities

- `exec-provenance-lineage`: file-tool writes through the mutate seam SHALL produce collector records (today input/output attribution comes exclusively from exec frames); registration SHALL attribute agent-authored files to their file tool rather than dropping them into the leaf bucket.
- `harness-workspace-tools`: the `WorkspaceMutator` seam gains a provenance-recording obligation — a successful `write_file`/`edit_file` write records a file-tool provenance record; failed or out-of-scope writes record nothing.

## Impact

- `src/tools/workspace/mutator.ts` — accept the collector (construction-time dep, like the seam's other step-scoped deps) and the calling tool's name; record on `status: "ok"`.
- `src/tools/workspace/write-file.ts`, `edit-file.ts` — pass their tool name through the single `mutator.writeFile` chokepoint.
- `src/agents/sandbox/shared.ts` — wire `deps.lineageCollector` into `createWorkspaceMutator` (already in scope at the composition point).
- `src/provenance/collector.ts` — step-prefix normalization + docstring fix; `src/execution/artifact-record.ts` — docstring fix.
- Tests: mutator/write/edit tool tests, collector tests, mutate-surface invariants.
- Not affected: the sandbox exec frame handling (the mutator's write exec frame stays unconsumed — the in-process record is the sole, richer attestation), the cli bridge, the PROV document builders.
