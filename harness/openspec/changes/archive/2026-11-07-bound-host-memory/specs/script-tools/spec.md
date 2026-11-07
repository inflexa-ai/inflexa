# Spec Delta

## MODIFIED Requirements

### Requirement: A script runs in an isolated VM with a deadline and a heap limit

A script MUST run in a QuickJS VM in a worker thread, with no files, no network, no timers, and no modules. Its only capabilities are the calls of its script tools and of `describe`, thus a file tool is its only way to a file. One script MUST end at 180 seconds. The heap of the VM MUST stop at 256 MiB. The worker of the VM MUST have a V8 heap limit, and it MUST hold a script slot of the process while it runs. A cancel of the `run_script` call MUST reach the signal of each nested call.

#### Scenario: A script past its deadline

- **WHEN** a script runs for more than 180 seconds
- **THEN** the script ends, and the result is `ok: false` with an error of the kind `timeout`

#### Scenario: A script waits for a slot

- **GIVEN** scripts that hold each script slot of the process
- **WHEN** a turn calls `run_script`
- **THEN** the script starts when a slot is free, and its result is the result of the script

### Requirement: A script reads a table through read_table

`read_table` MUST read one table through the guarded read of the workspace, thus a path outside the analysis and a symbolic link are refused. It MUST read CSV, TSV, a JSON array of flat objects, and parquet, up to 16 MiB. It MUST give each row as an object keyed by column. A plain decimal number MUST read as a number, and a cell with a leading zero MUST stay text. A larger table and a format with no parser MUST be an error that names an analysis run.

`read_table` MUST take `columns`, `offset`, and `limit`. It MUST give only the named columns and only the rows from `offset`, up to `limit` rows. `rowCount` MUST give the rows of the read, and `totalRows` the rows of the whole table. A parquet read MUST decode only the named columns and rows. A read whose cells pass 500,000 MUST be an error that names the cell count, the budget, the columns of the table, and the ways to read less. A parquet read MUST refuse before it decodes a page.

#### Scenario: A table with a numeric column and an identifier

- **GIVEN** a CSV with the rows `TP53,0.001,007` and `FLT3,0.2,12` under the header `gene,padj,id`
- **WHEN** a script reads it
- **THEN** the rows are `{ gene: "TP53", padj: 0.001, id: "007" }` and `{ gene: "FLT3", padj: 0.2, id: 12 }`

#### Scenario: A table over the cap

- **WHEN** a script reads a CSV of more than 16 MiB
- **THEN** the call throws an Error that names the cap and an analysis run

#### Scenario: A wide parquet table over the cell budget

- **GIVEN** a parquet file of 50,000 rows and 77 columns
- **WHEN** a script reads it with no `columns`
- **THEN** the call throws an Error that names 3,850,000 cells, the budget, the columns, `columns`, `offset` with `limit`, and `grep`
- **AND** no page of the file is decoded

#### Scenario: The same table with columns

- **GIVEN** the same parquet file
- **WHEN** a script reads it with `columns: ["layer", "feature", "signature_class"]`
- **THEN** the rows hold those three columns only, and `rowCount` and `totalRows` are 50,000

#### Scenario: A page of rows

- **WHEN** a script reads a CSV of 1,000 rows with `offset: 100` and `limit: 50`
- **THEN** the rows are the rows 101 to 150 of the table, `rowCount` is 50, and `totalRows` is 1,000

### Requirement: The metrics of the scripts show when a script outgrows the VM

`run_script` MUST count each script by its failure: none, a script error, an exhausted heap, a timeout, an abort, or a fault of the VM. `read_table` MUST count each refused read by its reason, and it MUST record the bytes of each read, in buckets from 1 KiB to 64 MiB. A read over the cell budget MUST count with the reason `over_budget`, and a decode that ran out of memory MUST count with the reason `out_of_memory`. A replay MUST count nothing, because it runs no body.

#### Scenario: A table over the cap counts

- **WHEN** a script reads a table of more than 16 MiB
- **THEN** the counter of refused reads grows by one with the reason `too_large`

#### Scenario: A read of some megabytes lands in a bucket

- **WHEN** a script reads a table of 3 MiB
- **THEN** the histogram counts it in the bucket up to 4 MiB, and not in the overflow bucket

#### Scenario: A read over the cell budget counts

- **WHEN** a script reads a table whose cells pass the budget
- **THEN** the counter of refused reads grows by one with the reason `over_budget`
