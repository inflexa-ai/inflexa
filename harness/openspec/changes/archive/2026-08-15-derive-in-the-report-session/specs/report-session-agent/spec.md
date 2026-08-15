# Delta: report-session-agent

## MODIFIED Requirements

### Requirement: The read-only roster
The roster of the agent MUST hold: the workspace read tools (`read_file`, `list_files`, `file_stat`, and `grep`), the workspace search, `inspect_run`, `inspect_data_profile`, the authoring tools, the pinned-artifact listing tool, the derivation tool, and the render-and-preview tool. The roster MUST NOT hold a planner, a run launcher, a working-memory write, or a sandbox mutate surface. Thus no tool starts a run, and no tool changes an analysis. A session derivation is a sandbox exec inside the session: it mints no run id, it registers no artifact, and it writes under the session directory alone.

The listing tool MUST give the pinned artifacts in a deterministic order: the path, the hash, and the file type. It MUST also give the pinned citation ids. The listing is bounded, and a truncated listing MUST carry the total count and a truncation marker. For a `.csv` or a `.tsv` artifact it also gives the columns, from a bounded read of the header. A header that the bounded read cannot parse whole gives no columns. An unreadable header gives no columns and no error, because absence is a normal condition.

#### Scenario: The roster holds no run starter
- **WHEN** the assembled agent lists its tools
- **THEN** no tool id of the run-starter set or the mutate set is present

#### Scenario: The analysis read surface is present
- **WHEN** the assembled agent lists its tools
- **THEN** the workspace read tools, the search, the run inspection, and the data-profile inspection are present

#### Scenario: The listing gives the pinned set with columns
- **WHEN** the agent calls the listing tool in a session whose snapshot pins a CSV artifact
- **THEN** the result carries the path, the hash, the file type, and the header columns of that artifact

#### Scenario: An unreadable artifact still lists
- **WHEN** the snapshot pins a path whose bytes are absent from the disk
- **THEN** the result carries the path and the hash, with no columns and no error

#### Scenario: A large pinned set truncates with a marker
- **WHEN** the snapshot pins more artifacts than the listing bound
- **THEN** the result carries the bounded listing, the total count, and the truncation marker

#### Scenario: A derivation starts no run
- **WHEN** the agent derives a table in a session
- **THEN** no run row and no artifact row lands, and the output sits under the session directory

## ADDED Requirements

### Requirement: The session derivation
The derivation tool MUST run an agent-authored script on the sandbox substrate: the container rails, the resource policy, no network, and the signed exec protocol. The analysis tree mounts read-only, and one write mount covers the session `derived/` directory alone. The script writes its output into that mount directly. Each declared input MUST sit in the served membership, and its hash comes from there. The record lands in the durable session state: the output path, the output hash, the source paths with their hashes, the script hash, and the script text. The served snapshot MUST merge the derivation records, thus a derived table binds the same way as a pinned one. The stored pin never changes. The tool MUST refuse an output name that a record already holds.

#### Scenario: A derived table becomes bindable
- **WHEN** a derivation lands and the agent adds a table block over the derived path
- **THEN** the block lands, and the reference resolves against the derived output

#### Scenario: The record chains the provenance
- **WHEN** a derivation lands
- **THEN** the session state holds the output hash, the source hashes, the script hash, and the script text

#### Scenario: A write outside the derived directory fails
- **WHEN** the script writes a path outside the `derived/` mount
- **THEN** the write fails inside the container, because the one write mount covers `derived/` alone

#### Scenario: A repeated output name refuses
- **WHEN** the agent derives onto a name that a record already holds
- **THEN** the tool refuses as typed data, and the record stays as it is

#### Scenario: The purge covers the derived directory
- **WHEN** the session pages dispose
- **THEN** the `derived/` directory goes with the session directory
