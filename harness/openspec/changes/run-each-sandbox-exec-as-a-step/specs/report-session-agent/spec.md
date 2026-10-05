## MODIFIED Requirements

### Requirement: The session derivation
The derivation tool MUST run an agent-authored script on the sandbox substrate: the container rails, the resource policy, no network, and the exec protocol of the harness-sandbox-exec spec. The analysis tree mounts read-only, and one write mount covers the session `derived/` directory alone. The script writes its output into that mount directly. Each declared input MUST sit in the served membership, and its hash comes from there. The record lands in the durable session state: the output path, the output hash, the source paths with their hashes, the script hash, and the script text. The served snapshot MUST merge the derivation records, thus a derived table binds the same way as a pinned one. The stored pin never changes. The tool MUST refuse an output name that a record already holds.

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

