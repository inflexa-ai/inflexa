## MODIFIED Requirements

### Requirement: CLI verify command

The system SHALL register `inflexa prov verify <analysis>` as a client of the local server. It SHALL resolve the analysis by id-or-name through the resolve route of the server, and a name that more analyses share SHALL fail with each candidate rather than pick one. The server SHALL recompute the chain hash from the stored PROV-JSON, verify the stored signature against the public key, and return the verification result (`GET {A}/provenance/verify`). The command SHALL print the result, and SHALL exit non-zero for `tampered` and `verify-error`.

#### Scenario: Valid signed provenance

- **WHEN** `inflexa prov verify my-analysis` runs against an analysis with a valid signature
- **THEN** it prints a success message indicating the provenance chain is intact and the signature is valid

#### Scenario: Tampered provenance

- **WHEN** `inflexa prov verify my-analysis` runs against an analysis whose `provenance` column was modified after signing
- **THEN** it prints a failure message indicating the provenance has been tampered with
- **AND** the exit code is non-zero

#### Scenario: Unsigned provenance

- **WHEN** `inflexa prov verify my-analysis` runs against an analysis with `NULL` chain hash and signature
- **THEN** it prints a message indicating the provenance is unsigned (recorded before integrity was enabled or without a keypair)

#### Scenario: Missing public key

- **WHEN** `inflexa prov verify my-analysis` runs with a stored signature but the `prov_key.json` file is absent
- **THEN** it prints a message indicating the signature exists but cannot be verified without the key

#### Scenario: No provenance recorded

- **WHEN** `inflexa prov verify my-analysis` runs against an analysis with `NULL` provenance
- **THEN** it prints a message indicating no provenance has been recorded yet

#### Scenario: Unknown analysis

- **WHEN** `inflexa prov verify nonexistent` runs
- **THEN** it prints an error that no analysis matches the reference

#### Scenario: An ambiguous name names each candidate

- **WHEN** `inflexa prov verify shared-name` runs and two analyses have that name
- **THEN** it exits non-zero and lists each candidate with its id, so the user can run it again with an exact id

### Requirement: TUI verify command

The system SHALL add a "Verify provenance (internal)" entry to the command palette (category "Analysis"), enabled when an analysis is open. It SHALL ask the local server for the verification result of the stored chain (`GET {A}/provenance/verify`) and display the result as a notice. A failed request SHALL display an error notice. The system SHALL also add a "Verify provenance (export)" entry. For it, the server SHALL name the path of the exported `provenance.json` of the analysis. Then the TUI process SHALL verify that file against its attestation, the same as `inflexa prov verify-file`, because the check reads only the two files.

#### Scenario: TUI verify shows result as notice

- **WHEN** the user selects "Verify provenance (internal)" from the command palette
- **THEN** a notice is displayed with the verification status that the server returned

#### Scenario: An export with no attestation is named

- **WHEN** the user selects "Verify provenance (export)" and the analysis has no exported `provenance.json`
- **THEN** a notice tells the user to export the provenance first

## ADDED Requirements

### Requirement: The export runs in the local server after a recorder flush

`inflexa prov export` and the export entries of the TUI palette SHALL be clients of `POST {A}/provenance/export`. The server SHALL flush the in-memory appends of the provenance recorder into the signed chain before it serializes the document, thus each export holds each event that the server recorded. A flush that fails SHALL NOT stop the export: the export then holds the last stored chain. The command SHALL resolve `--output` against its own working folder and send the absolute path. Without `--output`, the server SHALL write into the output folder of the analysis. A signing failure SHALL refuse the export with its signing error named, and nothing SHALL be written.

#### Scenario: An export includes the newest events

- **GIVEN** a server whose recorder holds an input change that it did not flush yet
- **WHEN** `inflexa prov export my-analysis` runs
- **THEN** the written document holds that input change

#### Scenario: A relative output path is the folder of the command

- **WHEN** `inflexa prov export my-analysis --output out/prov.json` runs in the folder `/work`
- **THEN** the server writes `/work/out/prov.json`, not a path under the folder of the server process
