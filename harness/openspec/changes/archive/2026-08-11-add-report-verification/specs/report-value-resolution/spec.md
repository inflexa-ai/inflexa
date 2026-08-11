## ADDED Requirements

### Requirement: One production resolver behind the one seam
The harness MUST give one production `ReferenceResolver` realization. The preview and the record gate MUST resolve through the same realization. The realization MUST select its read strategy internally, thus a caller never names a strategy.

#### Scenario: One seam serves the preview and the gate
- **WHEN** the preview and the record gate each resolve the same reference
- **THEN** each gets the value from the same realization, and the answers agree

### Requirement: The identity compare runs at every size
The realization MUST compare membership and the content hash before any read of cells. The hash compare MUST use a streamed read, and it MUST run for a file of any size. A mismatch MUST fail with `hash-mismatch` before any parse.

#### Scenario: A drifted file fails before a parse
- **WHEN** the bytes at a pinned path hash to a different value than the pin
- **THEN** resolution fails with `hash-mismatch`, and no parser runs

### Requirement: The host fast path under the cap
The realization MUST parse CSV, TSV, JSON, and parquet in process for a file at or under the cap. The parquet read MUST use a pure-JavaScript reader, thus no native library enters the package. The cap MUST be a composition-root value with a 16 MiB default. The host arm MUST parse a strict dialect only.

#### Scenario: A small CSV resolves in process
- **WHEN** a reference addresses a cell in a 2 MiB CSV
- **THEN** the host arm gives the cell, and no sandbox starts

#### Scenario: The embedder tunes the cap
- **WHEN** the composition root sets a 4 MiB cap
- **THEN** a 10 MiB file takes the fall-through

### Requirement: The fall-through takes every doubt
An over-cap file, an unknown format, and a host parse fault MUST take the sandbox fall-through. The host arm MUST NOT give a partial or guessed answer. Thus correctness never depends on the host parser.

#### Scenario: A parse fault falls through
- **WHEN** the host parser fails on an odd CSV dialect
- **THEN** the realization sends the file to the sandbox arm, and no refusal comes from the host fault

### Requirement: The sandbox arm submits one fixed script
The sandbox arm MUST run as a one-shot workflow with the shape of the data profile. The authorization MUST mint at the async edge and ride in the workflow input. The workflow MUST run only the one extraction script that the harness ships as an asset, and no agent loop runs in the container. The input MUST be a JSON list of path and locator pairs. The output MUST be one JSON value map. One submission MUST cover every fall-through file of one document pass.

#### Scenario: One pass makes one submission
- **WHEN** a document pass meets three over-cap files
- **THEN** the arm makes one submission that covers the three files

#### Scenario: No agent script enters the arm
- **WHEN** any caller resolves through the realization
- **THEN** the submitted script is the shipped asset, byte for byte

### Requirement: An absent sandbox arm is a typed failure
While no sandbox realization is wired, a reference on the fall-through path MUST fail with the reason `extraction-unavailable`. The detail MUST name the absent arm. The host arm MUST keep serving the under-cap files.

#### Scenario: The under-cap majority survives an absent arm
- **WHEN** no sandbox arm is wired, and a document holds one over-cap reference and nine under-cap references
- **THEN** the nine resolve, and the one fails with `extraction-unavailable`

### Requirement: One assert semantics for each realization
The assert rules MUST live in shared functions, and both realizations MUST call them. The rules are the tolerance compare, the percent-fraction rule, and the citation assert. Thus the fixture stays the executable specification of the value tier.

#### Scenario: The two realizations agree on a tolerance
- **WHEN** the fixture and the production realization match one assert with one tolerance
- **THEN** the two give the same outcome

### Requirement: The production realization batches in prepare
When the validator calls `prepare`, the realization MUST group the references by artifact, read each file one time, and fill a cache. After a prepare, `resolve` MUST answer from the cache. A resolve with no prior prepare MUST still answer, at the cost of a per-reference read.

#### Scenario: One file read serves many references
- **WHEN** ten references address one artifact and the validator runs prepare
- **THEN** the realization reads the artifact one time
