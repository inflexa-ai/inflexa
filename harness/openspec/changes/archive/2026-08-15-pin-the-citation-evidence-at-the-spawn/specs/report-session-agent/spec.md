# Delta: report-session-agent

## MODIFIED Requirements

### Requirement: The snapshot pins at session start
The runtime MUST give an idempotent operation that makes sure that the session state of a thread exists. The first run of the operation MUST pin the snapshot with `pinReportSnapshot`, and it MUST write the row. The pin MUST carry the citation evidence of the analysis beside the artifact map, through the workspace-root seam of the runtime. Every later call MUST read the stored snapshot, and it MUST NOT pin again. A pin failure MUST return as typed data, and a later call can pin again, because no row was written.

The spawn MUST run the operation directly after the seed of the child lands. The spawn mints one moment, and the two pins of that moment are the anchor of the transcript and the snapshot of the data. A pin at the first tool call of a later turn reads a different moment. A run can register an artifact between the two, and the session then cites an artifact that the anchor never held.

A failed pin at the spawn MUST NOT fail the spawn, and it MUST NOT remove the child. The operation is idempotent, thus a later call pins again. The failure MUST reach the injected logger.

The serving path of a report turn MUST run the operation at the start of the turn. Thus a session that the spawn could not pin still anchors before its first tool call.

#### Scenario: The spawn pins the snapshot

- **WHEN** the spawn makes a report child
- **THEN** the session state of the child holds the snapshot before the first turn runs

#### Scenario: An artifact of a later run is not a member

- **GIVEN** a spawned report child
- **WHEN** a run registers a new artifact, and the first turn of the child then runs
- **THEN** the stored snapshot holds no entry for that artifact

#### Scenario: A failed pin at the spawn keeps the child

- **WHEN** the pin fails at the spawn
- **THEN** the spawn gives the child, and the next call pins again

#### Scenario: The first served turn pins before any tool call
- **WHEN** the first turn of a report thread starts
- **THEN** the row holds the snapshot before a tool of the roster runs

#### Scenario: The pin runs one time
- **WHEN** a thread makes two authoring calls
- **THEN** the artifact ledger query runs one time, and both calls read one snapshot

#### Scenario: The membership survives a restart
- **WHEN** the process restarts after the pin, and a new artifact lands in the ledger
- **THEN** the next call reads the stored snapshot, and the new artifact is not a member

#### Scenario: A pin failure does not poison the thread
- **WHEN** the first pin fails and the store recovers
- **THEN** the next call pins again, and the session continues

#### Scenario: The stored snapshot carries the citation evidence
- **WHEN** the spawn pins a session of an analysis whose run synthesis carries key references
- **THEN** the stored snapshot citation list holds the `pmid:` key of each reference

### Requirement: The prompt obligations
The prompt of the agent MUST name its tools and their mechanisms, and it MUST NOT name a dataset, a path, or a format. The prompt MUST carry an explicit "Do NOT" list with the failure modes of report composition. The prompt MUST state that the agent grounds each claim through a reference, and that it does not transcribe a number from memory.

The prompt MUST teach the verification loop: preview, look, repair, and record only after a look at the current page. The "Do NOT" list MUST name the visual spiral. The agent does not loop on a cosmetic doubt, and it records when the page reads clean.

The prompt MUST name the listing tool as the orientation source for the pinned evidence. It MUST state that a reference names the path alone, and that the session stamps the hash. The "Do NOT" list MUST name the hash probe: the agent never guesses a hash, and it never adds a block to read a hash from a refusal.

The prompt MUST state that the literature references compose as citation blocks, against the citation ids of the pinned evidence. It MUST name the listing tool as the route to the pinned citation ids. It MUST state that a citation outside the pinned evidence does not resolve, and that the agent reports it instead of an inline workaround.

#### Scenario: The prompt stays free of environment detail
- **WHEN** a reviewer reads the prompt module
- **THEN** no dataset name, no path, and no format promise is present

#### Scenario: The prompt teaches the loop order
- **WHEN** a reviewer reads the prompt module
- **THEN** the loop order and the visual-spiral anti-pattern are present

#### Scenario: The prompt teaches the path-only rule
- **WHEN** a reviewer reads the prompt module
- **THEN** the listing tool is the named orientation source, and the hash-probe anti-pattern is present

#### Scenario: The prompt teaches the citation blocks
- **WHEN** a reviewer reads the prompt module
- **THEN** the citation-block rule and the pinned-evidence bound are present
