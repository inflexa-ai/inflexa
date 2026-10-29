# Record the workspace reads of a step in its lineage

## Why

The collector of a step records only the reads that a sandbox exec observes. `read_file`, `grep`, and `read_pdf` read on the host, thus no exec frame names their reads. An agent that reads `data/counts.csv` with `read_file` and then writes `summary.md` gives an analysis with no `used` edge to `counts.csv`. A reviewer who trusts the lineage then learns that the record is not complete (issue #79).

## What Changes

- `read_file`, `grep`, and the `read_pdf` script tool of a step agent put their reads into their call record. Their `foldCallRecord` tracks each read in the collector of the step with `trackInputAccess`. Thus a replay rebuilds the same inputs.
- A read uses the mount root of `execute_command`, thus a file that an exec and a read tool read is one input.
- `classifyReadPath` classifies a read the same as an exec read. A read of an undeclared same-run sibling gets no input, and the harness logs the refusal one time.
- `read_file` records a read that gave text to the agent. `grep` records each file whose lines its result returns.
- A read of the whole file carries the SHA-256 of the bytes that the tool read. A read of a part (a line window or a truncated read) carries no hash, and `reconcileManifestWithDisk` hashes the file from disk.
- `workspace_search`, `list_files`, and `file_stat` record nothing. They give paths, descriptions, and metadata, not the content of a file.

## Impact

- `harness/src/provenance/workspace-reads.ts` (new), `harness/src/tools/workspace/read-file.ts`, `harness/src/tools/workspace/grep.ts`, `harness/src/tools/script/file-tools.ts`, `harness/src/agents/sandbox/shared.ts`, and their tests.
- The cli bridge and the prov-kernel need no change. `getTrackedInputs` already gives one `prov.input_used` event for each tracked input that is not an `artifacts` read.
- The conversation agent and the report-session agent have no step collector, thus their read tools attach no read record.
