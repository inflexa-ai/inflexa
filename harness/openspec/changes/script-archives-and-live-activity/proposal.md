## Why

A file that a chat thread or a report session writes lives only in the workspace tree. A managed host keeps the files of an analysis in its own store, and a file outside a run has no way there, thus a user cannot open a derived file or an exported PDF from the web app.

A script refuses a compressed table, for example a GEO supplementary `.csv.gz` or a `.zip` of tables, and the agent falls back to a sandbox run for a read that the host can do. The nested calls of a script reach a surface only when the script ends, thus a long script looks stalled. The histogram of read bytes uses the default OTel buckets, which stop at 10000 bytes, thus each real table lands in the overflow bucket.

## What Changes

- New script tool `list_archive`: the files inside a zip, a tar, a tar.gz, or a gz, with their decompressed sizes.
- `read_table` and `read_pdf` take an optional `entry`, one file inside a compressed file. A gzip-compressed file reads with no entry.
- Each read of an entry is capped: the compressed file at 64 MiB, the decompressed stream of a tar.gz at 64 MiB, and the entry at the cap of its reader.
- `run_script` emits live, transient copies of its `data-subagent-activity` part while the script runs, at most one each 500 ms. The part at the end stays the stored one.
- A `ChatDataPart` can carry `transient: true`. A tool step writes such a part as progress, and the step does not checkpoint it.
- `cortex.harness.script.read_bytes` gets byte buckets from 1 KiB to 64 MiB.
- New optional notice `syncSessionFile` on `CoreRuntimeDeps`: each file that a session writes outside a run reaches it with its bytes and its owner, the thread or the analysis.

## Capabilities

### New Capabilities

- `session-file-sync`: the host copy of each file that a session writes outside a run.

### Modified Capabilities

- `script-tools`: compressed files, the live activity of a script, the read buckets.
- `run-synthesizer`: the script tools hold `list_archive`.
- `planning-enhancements`: the script tools of the planner hold `list_archive`.

## Impact

- `harness/src/tools/script/` (`archive.ts`, `file-tools.ts`, `run-script.ts`, `metrics.ts`), `harness/src/loop/chat-stream.ts`, `harness/src/loop/types.ts`.
- New direct dependency `fflate` (zero dependencies, already in the tree through pdfkit).
- A surface that renders `data-subagent-activity` gets the nested calls while the script runs.
