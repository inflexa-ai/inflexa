# Tasks

## 1. Heavy workers

- [x] 1.1 Add `src/lib/host-workers.ts`: the decode and script slot queues, the worker entry URL and its setter, `runHostTask` (a fresh worker with `resourceLimits` for each task, the bytes transferred, `out_of_memory` and `crashed` failures), and `HOST_WORKER_MEMORY_MIB`.
- [x] 1.2 Make `src/tools/script/codemode-worker.ts` the harness worker entry: run a harness task from the worker data, else import the pi-codemode worker.
- [x] 1.3 Add the task bodies in `src/workspace/decode-tasks.ts`: `table`, `archive-list`, `pdf-text`.
- [x] 1.4 `assembleCoreRuntime` gives `scriptRuntime.workerUrl` to the module.
- [x] 1.5 Tests: a task that passes its heap limit fails with `out_of_memory` under Node and the process continues; a third task waits for a slot; a failed task frees its slot.

## 2. Table decode with a budget and one copy

- [x] 2.1 Move the decode of `parseTable` to a budgeted decode: parquet from the metadata with `columns`, `rowStart`, `rowEnd`, and an in-place cell coercion; CSV, TSV, and JSON with a cell count that stops at the budget; the column keep and `numericCell` in the same pass.
- [x] 2.2 `read_table`: `offset` and `limit`, the decode in the worker, the refusal over the budget, and `totalRows` of the whole table.
- [x] 2.3 `list_archive`, the entry read, and `read_pdf` decode in the worker.
- [x] 2.4 Metrics: the refusal reasons `over_budget` and `out_of_memory`.
- [x] 2.5 Tests: the wide parquet refuses before a decode, the column read, the page of rows, the CSV budget stop, and the existing table, archive, and PDF tests still pass.

## 3. The VM of run_script

- [x] 3.1 A harness launcher for `CodemodeSandboxBase` that waits for a script slot and starts the worker with `resourceLimits`.
- [x] 3.2 The bridge limit in `runNestedCall`: a size walk with no copy that stops at 32 MiB; remove `plainJson` from the nested path.
- [x] 3.3 Tests: a host script tool over the limit fails the call and the script catches it; a script waits for a slot.

## 4. Report path

- [x] 4.1 `hostReadCells` decodes through the `table` task with the report budget; over the budget and out of memory take the fall-through.
- [x] 4.2 The read store: one process cache bounded by 2,000,000 cells and 128 entries.
- [x] 4.3 Tests: a table over the budget falls through; the cache drops by cells.

## 5. Finish

- [x] 5.1 Update `CLAUDE.md` (key components: the heavy workers) (`CONTEXT.md` names no decode on the host).
- [x] 5.2 `bun run format:file` on the changed files, `tsc -p tsconfig.build.json`, `bun run typecheck`, `bun run lint`, and the full `bun test` one time.
