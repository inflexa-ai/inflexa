## ADDED Requirements

### Requirement: inflexa prov verify checks provenance integrity

The system SHALL register `inflexa prov verify <analysis>` under the existing `prov` command group that resolves the analysis by id-or-name, runs the verification logic, and prints the result. The action SHALL live in `src/modules/prov/verify.ts` and be lazy-imported from `src/cli/index.ts`.

#### Scenario: Verify subcommand is registered

- **WHEN** `inflexa prov --help` is run
- **THEN** the `verify` subcommand is listed alongside the existing `export` subcommand

#### Scenario: Verify runs and reports

- **WHEN** `inflexa prov verify my-analysis` is run
- **THEN** the analysis is resolved, verification is performed, and the result is printed to stdout

### Requirement: inflexa prov verify-file checks an exported provenance file

The system SHALL register `inflexa prov verify-file <path>` under the existing `prov` command group that reads a provenance file and its `.sig.json` sidecar from disk, runs file-based verification, and prints the result. No database or analysis row is required. The action SHALL live in `src/modules/prov/verify.ts` and be lazy-imported from `src/cli/index.ts`.

#### Scenario: Verify-file subcommand is registered

- **WHEN** `inflexa prov --help` is run
- **THEN** the `verify-file` subcommand is listed

#### Scenario: Verify-file runs on exported files

- **WHEN** `inflexa prov verify-file ./provenance.json` is run with a valid sidecar alongside
- **THEN** the file and sidecar are read, verification is performed, and the result is printed to stdout
