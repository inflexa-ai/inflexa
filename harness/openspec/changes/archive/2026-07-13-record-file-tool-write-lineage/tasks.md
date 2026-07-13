## 1. Collector groundwork

- [x] 1.1 Normalize paths step-relative inside `recordFileToolWrite` (`src/provenance/collector.ts`): strip `stepPrefix` when present (mirror `recordCommandExecution`), apply the normalized key to both the `commandRecords.delete` unlink and the `fileToolRecords.set`; fix the docstring to name the real tools (`write_file`, `edit_file`) instead of `append_file`/`copy_file`
- [x] 1.2 Fix the stale `toolName` docstring in `src/execution/artifact-record.ts` (names `append_file`)
- [x] 1.3 Collector unit tests: step-prefix normalization keys file-tool and command records into one keyspace; file-tool-then-command and command-then-file-tool last-write-wins both resolve to the later producer

## 2. Mutate seam recording

- [x] 2.1 Extend `WorkspaceMutatorDeps` with an optional `lineageCollector` (the step-scoped `ProvenanceCollector`) and `writeFile` args with the invoking tool's name; on `status: "ok"` compute `sha256:<hex>` (shared `lib/fs-helpers.ts` content hasher) + byte size from `contentBytes` and call `recordFileToolWrite`; record nothing on `out_of_scope`/`out_of_prefix`/`write_failed` or when no collector was supplied (`src/tools/workspace/mutator.ts`)
- [x] 2.2 Pass the tool name at the two chokepoint call sites: `write_file` (`src/tools/workspace/write-file.ts`) and `edit_file` (`src/tools/workspace/edit-file.ts`)
- [x] 2.3 Wire `deps.lineageCollector` into `createWorkspaceMutator` at the composition point (`src/agents/sandbox/shared.ts`)

## 3. Tests over the seam behavior

- [x] 3.1 Mutator tests: a successful write records producer `{ type: "file_tool", tool }` with non-empty `sha256:<hex>` hash, correct size, `inputs: []`; failed/confinement-rejected writes and collector-less mutators record nothing (`mutator` / mutate-surface invariant tests)
- [x] 3.2 Seam-integration test: a `write_file` output registers with its file-tool record reachable via `collector.getRecords()` under the step-relative key a manifest entry would use — not as a record-less leaf
- [x] 3.3 Guard test: the mutate seam's own exec result never feeds `feedExecFrame` — after a write, the collector holds no command record for the written path

## 4. Gates

- [x] 4.1 `bun run typecheck`, lint on touched files, full harness test suite green
- [x] 4.2 Grep-verify `recordFileToolWrite` now has non-test callers, and no comment/spec text still names `append_file`/`copy_file`
