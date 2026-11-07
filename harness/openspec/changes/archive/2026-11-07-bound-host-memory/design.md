# Design

## Context

See proposal.md, Why. The relevant facts of the code:

- `run_script` builds a `CodemodeSandbox` (`@earendil-works/pi-codemode` 1.4.0). Its launcher starts `new Worker(url, { workerData })` with no `resourceLimits`, and `acquireWorker()` is its only capacity hook, a synchronous one. The sandbox calls each nested tool on the main thread and serializes its return value with `JSON.stringify` (`runtime/execution.ts`).
- `CodemodeSandboxBase` is exported and takes a launcher, thus the harness can own the `Worker` construction with no fork.
- Under Node, a worker with `resourceLimits` that passes its old-generation limit emits `ERR_WORKER_OUT_OF_MEMORY` and exits, and the main thread continues (measured). Bun accepts the option and does not enforce it (measured).
- A compiled Bun binary does not embed a worker file that the code names with `new URL(...)`. The CLI embeds the one entry `tools/script/codemode-worker.js` as an extra entrypoint and gives its path as `ScriptRuntime.workerUrl`.
- `hyparquet` reads the metadata of a file (row count, schema) with no decode of a page, and `parquetRead` takes `columns`, `rowStart`, and `rowEnd`.
- `--max-old-space-size` applies to each isolate. The heap of a worker and the memory of a wasm VM are outside the heap of the main thread.

## Goals / Non-Goals

**Goals**

- A read of untrusted file content fails its call and never stops the host process, under Node.
- One mechanism for each kind of memory-heavy decode, that a new tool reuses.
- Fewer whole copies of a table on the main thread.
- A declared upper bound of the worker memory, thus a host sizes its own heap beside it.

**Non-Goals**

- A bound on what a host-written tool allocates on the main thread. The bridge limit stops such a result from going further, but the allocation itself is the code of the tool. A tool that decodes file content uses the decode workers.
- Memory limits under Bun. The CLI keeps the cell budget and the bridge limit.
- A streaming result into the VM. The VM still receives one JSON text for each nested call.

## Decisions

### D1. One process-wide module owns the heavy workers

`src/lib/host-workers.ts` holds two queues of fixed width for the whole process: the decode slots and the script slots. A memory budget belongs to the process, not to one runtime or one agent, thus the queues are module state, the same as the per-host budgets of `lib/host-concurrency.ts`. The worker entry URL is the one value that a host sets: `assembleCoreRuntime` gives `scriptRuntime.workerUrl` to the module, and with no value the module resolves the entry beside itself.

Alternative: thread a `HostWorkers` dep through each factory that reads a file (the conversation agent, the sandbox agents, the planner, the synthesis, the report agent, the resolver). It touches each composition path for one process-wide value, and two runtimes in one process would get two budgets for one container.

### D2. The decode runs in a fresh worker for each task, from the existing entry

`codemode-worker.ts` becomes the harness worker entry. When its worker data carries a harness task, it runs that task and posts the answer. Otherwise it imports the pi-codemode worker as before. Thus a bundled host embeds nothing new.

Each task starts a new worker and ends it. A worker that ran out of memory is dead in any case, and a fresh worker leaves no heap of an earlier task behind. The start costs tens of milliseconds, which is small beside a decode of megabytes.

The tasks:

- `table`: open the entry of a compressed file when one is named, then decode the table with the budget (D4).
- `archive-list`: the files of a compressed file.
- `pdf-text`: the text of a range of pages.

The main thread reads the bytes through the workspace seam, as now, because the seam confines the path. It computes the hash of the bytes, then it transfers the bytes to the worker with no copy.

Alternative: a pool of long-lived workers. It saves the start, but a worker that ran out of memory must be replaced, and a long-lived heap holds the garbage of earlier tasks against the limit.

### D3. The harness launches the VM of `run_script`

`run_script` constructs `CodemodeSandboxBase` with a harness launcher. The launcher waits for a script slot, starts the worker with `resourceLimits`, and frees the slot when the worker exits. It keeps the interrupt flag and the stop of the pi launcher. The wait is asynchronous, thus a script waits in the queue and does not fail when each slot is held.

The worker of a script holds the JSON of each nested result and the printed output, thus its heap limit is small. The VM keeps its own `memoryLimitBytes` of 256 MiB in wasm memory.

### D4. The cell budget is checked before the decode

A cell is one value of one row and one column. The budget counts the cells that a read gives: the rows in the range times the kept columns.

- Parquet: the worker reads the metadata, checks that each requested column exists, and computes the cells from the row count, the range, and the columns. Over the budget, it refuses before it decodes a page. Under the budget, it reads only the requested columns and rows, and it coerces each cell in place.
- CSV, TSV, JSON: the format has no index, thus the worker counts the cells while it parses, and it stops at the first cell past the budget. The refusal gives the row count up to the stop and says that the table has more.

A refusal of `read_table` names the cells, the budget, the columns, and the three ways to read less: `columns`, `offset` with `limit`, or `grep` for a few rows. The model can then act on it in the same script.

The budget of `read_table` is 500,000 cells, sized to stay under the bridge limit (D5) for typical column names. The budget of the report path is 1,000,000 cells, because the resolver keeps the rows on the host and gives none to a VM.

### D5. The bridge limit measures the JSON size with no copy

`runNestedCall` walks the result value and adds the size of its JSON text: the strings, the keys, the numbers, and the punctuation. It stops at the first byte past the limit of 32 MiB. Over the limit, the call fails with an error that names the size and the limit. Under it, the value goes to the VM as it is.

`plainJson` goes. Its two jobs were to drop the symbol keys of the loop and to give a JSON value. `JSON.stringify` in the sandbox drops symbol keys too, and the walk refuses a value that JSON cannot carry (a `bigint`, a cycle). Thus the result reaches the VM with one serialization instead of three copies.

Alternative: serialize once in the harness and give the text. The sandbox serializes the return value itself, and `JSON.rawJSON` refuses an object or an array, thus the text would reach the script as a string.

### D6. The report resolver shares the decode and bounds its cache by cells

`hostReadCells` decodes through the `table` task with the report budget. Over the budget, the read takes the existing fall-through (`extraction-unavailable`). The read store holds one bounded map for the process instead of one map for each analysis. It evicts the least recently used entry while the held cells pass 2,000,000, or the entries pass 128.

### D7. The memory budget of the host

The harness exports `HOST_WORKER_MEMORY_MIB`, the sum of the limits of all slots:

| Slot | Count | Each |
|-|-|-|
| Decode worker | 2 | 384 MiB old generation |
| Script worker | 3 | 128 MiB old generation + 256 MiB VM |

The sum is 1,920 MiB. A host sizes its container limit at its main heap plus this budget plus about 15 percent for the native memory of the runtime. The Cortex chart subtracts the budget from the limit before it applies its heap percent.

## Risks / Trade-offs

- [A queue of two decodes delays a third read under load] → A decode takes well under a second for a table under the budget. The queue is a wait, not a failure.
- [A table that the old path read now refuses] → The refusal is at a cell count that cost hundreds of megabytes before. The refusal says how to read less, and `offset` with `limit` reads the rest in pages.
- [The size walk adds a pass over each nested result] → The walk allocates nothing and stops at the limit. It is linear in a value that the sandbox serializes anyway.
- [A host-written tool can still allocate on the main thread] → The bridge limit stops the copies after it. The spec names the decode workers as the place for a decode of file content.
- [Under Bun no heap limit applies] → The budget and the bridge limit still hold. The CLI runs one user, and its memory is the memory of the machine.

## Migration Plan

The change needs no DBOS patch: it changes the inside of steps only. Cortex installs the release, and the chart change lands with it: the budget subtraction and the 4 GiB limit. A rollback is the earlier harness release and the earlier chart values.
