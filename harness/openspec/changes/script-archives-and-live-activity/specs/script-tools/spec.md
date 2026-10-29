## ADDED Requirements

### Requirement: A script reads a file inside a compressed file

`list_archive` MUST give each regular file inside a zip, a tar, a gzip-compressed tar, or a gzip-compressed file of the workspace, with its decompressed size. `read_table` and `read_pdf` MUST take an optional `entry`, the name of one file inside a compressed file, and read it as the file that the call names. A gzip-compressed file MUST read with no entry, as its one file. The read record MUST name the compressed file and the hash of its bytes.

#### Scenario: A table inside a zip

- **GIVEN** a zip that holds `GSE1/counts.csv`
- **WHEN** a script calls `list_archive` and then `read_table` with the entry `GSE1/counts.csv`
- **THEN** the list names `GSE1/counts.csv` with its size, and the rows are the rows of the table
- **AND** the read record names the zip and the hash of the zip

#### Scenario: A gzip-compressed table

- **WHEN** a script reads `counts.csv.gz` with no entry
- **THEN** the rows are the rows of the decompressed table

#### Scenario: A compressed file with no entry

- **WHEN** a script reads a zip with `read_table` and no entry
- **THEN** the call throws an Error that names `list_archive`

### Requirement: A read inside a compressed file is capped

Each read of a compressed file MUST be capped: the compressed file at 64 MiB, the decompressed stream of a gzip-compressed tar at 64 MiB, and the entry at the cap of its reader. A zip MUST refuse an entry whose indexed size passes the cap before it decompresses the entry, and it MUST hold the cap on the decompressed bytes too.

#### Scenario: An entry over the cap

- **WHEN** a script reads an entry of a zip whose decompressed size passes 16 MiB
- **THEN** the call throws an Error that names the cap, and the entry does not decompress

## MODIFIED Requirements

### Requirement: The conversation agent calls its lookups from a script

`createConversationAgent` MUST give each lookup, and `read_table`, `read_pdf`, `list_archive`, `write_derived`, and `render_chart`, as script tools, and it MUST NOT declare one as a tool of the agent. A lookup is a read-only API call, for example an identifier, the literature, a compound, or a target.

#### Scenario: The lookups are script tools only

- **WHEN** the conversation agent is built
- **THEN** its script tools include `read_table`, `list_archive`, `write_derived`, `render_chart`, `search_gene`, `pubmed`, `resolve_citation`, `chembl`, and `web_fetch`
- **AND** its tools include none of its script tools
- **AND** no script tool has an approval hook or starts a workflow

#### Scenario: Citation verification follows PubMed

- **WHEN** the conversation agent is built
- **THEN** `resolve_citation` comes directly after `pubmed` in its script tools

### Requirement: A nested call shows while the script runs

Each nested call MUST emit `tool-started` and `tool-finished` frames, with the detail of the nested tool. The source of the frames MUST be one level below the `run_script` call: the agent id `run_script`, the call path of the caller with `run_script` appended, and the invocation id of the `run_script` call. Thus a surface puts each nested call on the activity line of the `run_script` call. A `run_script` call of the root agent MUST also emit the `data-subagent-activity` part of its nested calls.

While the script runs, `run_script` MUST emit transient copies of that part, at most one each 500 ms. A change inside an interval MUST go at the end of the interval, thus a long nested call shows before it ends. The part at the end of the call MUST NOT be transient, and it is the part that a stored display keeps. Inside a tool step, the chat stream MUST write a data part with `transient: true` as progress, which the step does not checkpoint.

#### Scenario: A table read shows under the script

- **WHEN** a script reads `runs/r1/s1/output/de.csv` in the call `toolu_1`
- **THEN** the turn receives a `tool-started` frame of `read_table` with the detail of the path and the invocation id `toolu_1`, and a `tool-finished` frame with the detail `3 rows`

#### Scenario: A long nested call shows live

- **WHEN** a script calls a quick lookup and then a lookup that takes 800 ms
- **THEN** the turn receives a transient activity part with the quick lookup, and a second transient part with both lookups before the slow lookup ends
- **AND** the call ends with one activity part that is not transient

### Requirement: The metrics of the scripts show when a script outgrows the VM

`run_script` MUST count each script by its failure: none, a script error, an exhausted heap, a timeout, an abort, or a fault of the VM. `read_table` MUST count each refused read by its reason, and it MUST record the bytes of each read, in buckets from 1 KiB to 64 MiB. A replay MUST count nothing, because it runs no body.

#### Scenario: A table over the cap counts

- **WHEN** a script reads a table of more than 16 MiB
- **THEN** the counter of refused reads grows by one with the reason `too_large`

#### Scenario: A read of some megabytes lands in a bucket

- **WHEN** a script reads a table of 3 MiB
- **THEN** the histogram counts it in the bucket up to 4 MiB, and not in the overflow bucket
