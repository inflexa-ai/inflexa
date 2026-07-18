## ADDED Requirements

### Requirement: Reference inspection and verification have a machine-readable JSON mode

`inflexa refs list --json` SHALL emit on stdout a single JSON document carrying the store-level facts (the public store path, whether it exists, and unmanaged top-level content) and, for every canonical catalog dataset in catalog order, its identity and provenance fields (id, catalog version, title, description, source URL, license, group, recommended), its local install state (the same closed state set the human listing shows), the installed version and install timestamp when the dataset's files are actually present from a completed install — the `installed` and `update_available` states — (keys absent otherwise, never `null`), and its artifacts with their upstream URLs. A `partial` dataset's receipt SHALL NOT be surfaced as install facts, so key presence can never contradict `state` or misrepresent a damaged install as usable. The document SHALL be self-contained: artifact URLs are always present, and `--urls` SHALL have no effect on it. The shape SHALL be a CLI-owned projection constructed field-by-field — never a serialization of the harness catalog or receipt types — and SHALL be exported from the refs module as a typed value so in-process consumers use the same shape the flag prints.

`inflexa refs verify --json` SHALL emit on stdout a single JSON document wrapping the per-dataset verification results: dataset id, the active receipt version when one is valid (key absent otherwise), the overall dataset state, and per-file states.

Both JSON modes SHALL be byte-stable — the same store state SHALL produce byte-identical stdout across runs — and SHALL be side-effect-free, creating no directory or metadata even when the store does not exist. In JSON mode stdout SHALL carry either one complete JSON document or nothing: an inspection or verification failure SHALL leave stdout empty, report prose on stderr, and exit non-zero, exactly as the human mode's failure path does. A verification that completes but finds damage SHALL still emit the document, SHALL exit non-zero, and SHALL NOT print the human mode's advisory repair hint. The human-readable output of both commands SHALL be unchanged by this mode's existence.

#### Scenario: JSON list reports install state per catalog dataset

- **WHEN** `inflexa refs list --json` runs with one dataset installed and the rest absent
- **THEN** stdout is exactly one JSON document listing every catalog dataset in catalog order, the installed dataset carrying its state, installed version, and install timestamp from the active receipt, the absent ones carrying their state with no installed-version keys, and every dataset carrying its artifact upstream URLs without any additional flag

#### Scenario: JSON output is byte-stable and does not litter

- **WHEN** `inflexa refs list --json` runs twice before the store exists
- **THEN** both runs print byte-identical documents reporting the store as absent, and no directory or metadata is created

#### Scenario: Failure keeps stdout pure

- **WHEN** inspection fails in JSON mode
- **THEN** stdout carries no bytes, the error is reported as prose on stderr, and the command exits non-zero

#### Scenario: JSON verify reports damage in the document and the exit code

- **WHEN** an active managed file has been modified and `inflexa refs verify --json` runs
- **THEN** stdout is exactly one JSON document naming the affected dataset and file states, the command exits non-zero, and no advisory repair hint is printed

#### Scenario: A damaged install is not surfaced as install facts

- **WHEN** `inflexa refs list --json` runs against a dataset whose receipt is valid but whose installed files are incomplete
- **THEN** that dataset carries `"state": "partial"` and no installed-version or install-timestamp keys

#### Scenario: --urls does not change the JSON document

- **WHEN** `inflexa refs list --json --urls` runs
- **THEN** stdout is byte-identical to `inflexa refs list --json` on the same store state
