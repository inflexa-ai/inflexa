## ADDED Requirements

### Requirement: The workspace read tools of a step record their reads

When a sandbox step has a collector, `read_file`, `grep`, and the `read_pdf` script tool MUST put each file that they read into their call record, as an analysis-relative path. The `foldCallRecord` of the tool MUST track each read with `trackInputAccess`, under the mount root `/{analysisId}` of `execute_command`. Thus an exec and a read tool give one input for one file, and a replay rebuilds the same inputs.

#### Scenario: A read_file of a data file gives a data input

- **GIVEN** a step agent with a collector
- **WHEN** the agent reads the whole file `/{analysisId}/data/inputs/f1/counts.csv` with `read_file`
- **THEN** the collector tracks the input `/{analysisId}/data/inputs/f1/counts.csv` with `source: "data"` and the SHA-256 of the bytes that the tool read

#### Scenario: An exec and a read tool give one input

- **WHEN** the agent reads a file with `read_file`, and an exec frame reports a read of the same file
- **THEN** the collector tracks one input for the file

### Requirement: A workspace read is classified the same as an exec read

`classifyReadPath` MUST classify each read of a read tool. A read that classification refuses MUST NOT be tracked. The refusal MUST be logged one time for each path in the step.

#### Scenario: A read of an undeclared sibling gives no input

- **GIVEN** a step whose `dependsOn` does not hold `sibling`
- **WHEN** the agent reads `runs/{runId}/sibling/output/x.csv` with `read_file`
- **THEN** the tool returns the content, and the collector tracks no input

### Requirement: Only a read of the whole file carries a hash

A read of the whole file MUST carry the SHA-256 of the bytes that the tool read, and the tool MUST NOT read the file again for the hash. A read of a part (a line window, or a read that the byte cap truncated) MUST carry no hash, because the kernel keys an input entity on the path and the hash. `reconcileManifestWithDisk` then hashes the file from disk.

#### Scenario: A window read leaves the hash to the reconcile

- **GIVEN** a step with `dependsOn: ["qc"]`
- **WHEN** the agent reads `runs/{runId}/qc/output/qc.csv` with `headLines`
- **THEN** the collector tracks an `upstream` input for `qc` with an empty hash

### Requirement: A read tool records only the files whose content it gives

`read_file` MUST record a read that gave text to the agent, and no `binary`, `not_found`, or `out_of_scope` result. `grep` MUST record each file whose lines the result returns. `read_pdf` MUST record the `reads` of its call record, which `run_script` folds into the tool. `workspace_search`, `list_files`, and `file_stat` MUST record nothing, because they give no content of a file.

#### Scenario: grep records the files that its result returns

- **WHEN** the agent greps a directory where one file has a match and one file has none
- **THEN** the collector tracks only the file with the match

#### Scenario: A read_pdf in a script gives an input

- **WHEN** the agent calls `read_pdf` in a `run_script` script, and the loop folds the record of `run_script`
- **THEN** the collector tracks the PDF with the SHA-256 of its bytes
