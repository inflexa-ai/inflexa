## MODIFIED Requirements

### Requirement: Packages are discoverable via the list_available_packages tool

The harness MUST expose a `list_available_packages` tool, built with
`defineTool`. The tool MUST read the inventory source that the embedder
binds. A sandbox agent reads the `inflexa.lock` of the mounted farm,
because a step imports only what the farm links. A conversation or
planning surface reads a pool-scope source, because the ask flow marks the
packages that the POOL does not hold.

The tool MUST merge the image record into either report. The record is
`image-packages.json` at the store root. The default path MUST be the
container mountpoint, `/mnt/libs/image-packages.json`, and
`imagePackagesFile` names another location. The zod schema of the harness
MUST validate the record at each read, and that schema is the one
definition of the shape. An absent or invalid record MUST merge nothing,
and the report MUST stay whole. A `system_tools` entry MUST render under
the title `System tools (CLI)`, by its `executable` name, and a `node`
entry under the title `Node (npm)`.

Each answer MUST render the version beside the name, as `name==version`.
The targeted `names` path MUST also carry the store directory and the full
content hash when the source gives them. A full listing carries no hashes,
because a thousand rows of sha256 bury the signal. A missing or unreadable
source is an expected state: the tool MUST NOT throw — it MUST return an
`available: false` data variant carrying a fallback note rather than an
error. When the pool-scope source reports itself unavailable, the note
MUST carry the reason of the embedder. Without the reason, a structural
fault reads as a transient one, and the agent retries without end.

#### Scenario: Packages available

- **WHEN** `list_available_packages` is called and the `inflexa.lock` of the mounted farm is readable
- **THEN** it returns `{ available: true, ... }` with the farm inventory as `name==version` rows, merged with the image record

#### Scenario: Store not mounted

- **WHEN** `list_available_packages` is called and the lock cannot be read
- **THEN** it returns `{ available: false, content }`, and the content names the missing mount, without a throw

#### Scenario: A pool-scope answer carries the pinned version

- **WHEN** a conversation surface asks `names: ["scipy"]` against a pool that pins `scipy==1.16.3`
- **THEN** the answer marks it present as `scipy==1.16.3`, with the store directory and the full hash

#### Scenario: An unreadable pool names its reason

- **WHEN** the pool-scope source answers unavailable with a reason
- **THEN** the tool returns `available: false`, and the content carries that reason beside the UNKNOWN note

#### Scenario: The image record renders versions

- **GIVEN** a readable `image-packages.json` with `samtools` at `1.22.1` and `echarts` at `6.0.0`
- **WHEN** the tool lists with `language: "cli"`
- **THEN** the report holds `samtools==1.22.1` under `System tools (CLI)`, and no Node row

#### Scenario: A tool renders by its executable name

- **GIVEN** a `system_tools` entry with `name` `eagle2` and `executable` `eagle`
- **WHEN** the tool checks `names: ["eagle"]`
- **THEN** the answer marks it present under `System tools (CLI)`

#### Scenario: An absent image record merges nothing

- **GIVEN** a readable farm lock and no `image-packages.json` at the store root
- **WHEN** the tool lists
- **THEN** it returns `{ available: true, ... }` with the farm tracks alone, without a throw

#### Scenario: An invalid image record merges nothing

- **GIVEN** an `image-packages.json` that does not parse at schema 1
- **WHEN** the tool lists
- **THEN** it returns the farm tracks alone, without a throw
