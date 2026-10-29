## 1. Compressed files

- [x] 1.1 Add `archive.ts`: the kind of a compressed file, the list of its files, and the read of one entry, each under a cap
- [x] 1.2 Read each script file through one reader that opens an entry, and give `read_table` and `read_pdf` an optional `entry`
- [x] 1.3 Add the script tool `list_archive` to the conversation agent, the planner, and the synthesizer
- [x] 1.4 Tests for a zip, a tar with a long name, a tar.gz, a gz, an absent entry, and an entry over the cap

## 2. Live activity of a script

- [x] 2.1 Let a data part carry `transient`, and write it as progress from a tool step
- [x] 2.2 Emit a transient copy of the activity part at most each 500 ms, and a held-back copy at the end of the interval
- [x] 2.3 Tests for the first copy, the held-back copy, and the stored part at the end

## 3. Read buckets

- [x] 3.1 Give `cortex.harness.script.read_bytes` byte buckets from 1 KiB to 64 MiB, with a test

## 4. Session file sync

- [x] 4.1 Declare `SyncSessionFile`, and call it from the scratch, the session mutator, and the report `write_derived`
- [x] 4.2 Bind it on `CoreRuntimeDeps`, and pass it to the conversation agent and the report agent
- [x] 4.3 Tests for a thread-owned scratch file and an analysis-owned `write_file` write
