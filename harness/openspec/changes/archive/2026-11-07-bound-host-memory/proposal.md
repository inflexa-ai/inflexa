# Proposal

## Why

On 2026-11-07 the kernel killed a production Cortex pod for memory (exit code 137). A chat turn ran `run_script`, and the script called `read_table` on a parquet file under the 16 MiB cap, with no column filter. The pod went from about 1.5 GB to its 3 GiB limit in 24 seconds. Each other turn and run of the pod stopped with it.

The heap limit of the script VM did not help, because the memory was not in the VM. A nested call runs on the main thread of the host. The host decoded the whole file and then copied the rows some times before the VM received the JSON:

1. `parseParquet` decodes each row, and `coerceCell` makes a second set of row objects.
2. `readTableRows` keeps the requested columns in a third set.
3. `runNestedCall` serializes the result and parses it again (`plainJson`), and zod validates the parsed tree.
4. `pi-codemode` serializes the result again for the worker, and the worker copies the string.
5. Only the VM refuses the string, at its 256 MiB heap.

A measurement of the host side alone: a 15 MiB parquet file of 50,000 rows and 77 columns took 1.19 GB of RSS and gave a 98 MiB payload to the VM.

The 16 MiB cap counts compressed bytes. A parquet file compresses well, thus a file under the cap can decode to gigabytes. No other limit applied: the worker of a script has no heap limit, the host starts any number of script workers, and `--max-old-space-size` limits each isolate separately. Thus the process passes the limit of the container before any V8 heap stops.

The same class of fault exists outside scripts. The report resolver parses up to eight tables at the same time on the main thread, and it caches the parsed rows of up to 128 tables. `read_pdf` and the archive reads decode on the main thread.

The rule that this change makes true: a read of untrusted file content can fail a call, and it can never stop the host.

## What Changes

- **A standard for memory-heavy work.** The harness runs each decode of untrusted file content in a worker thread with a V8 heap limit, in a queue of fixed width for the whole process. A decode that passes its limit ends its worker, and the call gets an error. The host process continues. The decodes are a table (CSV, TSV, JSON, parquet), a compressed file (list and entry), and the text of a PDF.
- **One worker entry.** The decode tasks run in the worker entry that a bundled host already embeds for `run_script` (`tools/script/codemode-worker.js`). The entry selects the task from its worker data. A host needs no new build step.
- **The script VM gets the same limits.** `run_script` starts its VM through a harness launcher that gives the worker a V8 heap limit, and the launcher holds a slot of a fixed number of script workers for the process.
- **The bridge into a script has a size limit.** Before a nested result goes to the VM, the harness measures its JSON size with no copy. A result over the limit is a failed call that the script can catch. This holds for each script tool, also for a tool that a host adds.
- **`read_table` decodes only what the call asks for.** It gives the requested columns to the parquet reader, it takes `offset` and `limit` to read a range of rows, and it refuses a read whose cells pass a budget before it decodes them. The refusal gives the row count and the columns, thus the script can ask again with less.
- **Fewer copies.** The decode coerces each cell in its one pass and keeps only the requested columns. The worker gives the rows to the host in one transfer. `runNestedCall` gives the result to the VM with no JSON round trip.
- **The report resolver uses the same decode and budget.** A table over the budget takes the existing fall-through. The read cache holds rows up to a cell budget for the whole process, not up to a count of tables.
- **A memory budget for the host.** The harness exports the memory that its workers can use at most, thus a host can size its heap limit beside it.

## Capabilities

### New Capabilities

- `host-memory-bounds`: the standard for memory-heavy work in the host process: the bounded decode workers, the fixed queues, the limits of the script workers, the bridge limit, and the memory budget that a host sizes its heap against.

### Modified Capabilities

- `script-tools`: `read_table` takes `offset` and `limit`, gives the columns to the reader, and refuses a read over the cell budget. A nested result over the bridge limit is a failed call. The VM requirement names the limits of the worker.

## Impact

- `src/lib/host-workers.ts` (new), `src/tools/script/codemode-worker.ts`, `src/tools/script/run-script.ts`, `src/tools/script/file-tools.ts`, `src/tools/script/archive.ts`, `src/lib/pdf-text.ts`, `src/report-model/production-resolver.ts`, `src/runtime/assemble.ts`.
- Cortex: the chart of `platform-charts` must leave the worker budget out of the V8 heap of the host. The derivation of `--max-old-space-size` changes, and the production and staging memory limits go from 3 GiB to 4 GiB.
- The CLI: no change. It already gives the embedded worker entry as `ScriptRuntime.workerUrl`. Bun does not enforce `resourceLimits`, thus in the CLI the cell budget and the bridge limit are the guards.
