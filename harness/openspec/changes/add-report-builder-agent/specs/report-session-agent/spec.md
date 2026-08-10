## ADDED Requirements

### Requirement: The agent definition and its identity
The Report Builder agent MUST be one `AgentDefinition` with the id `report-session`, distinct from the id of the old templating agent. The system prompt MUST compose through `composeSystemPrompt` with the identity part and the conversational part. The definition MUST carry no per-session value, thus the prompt prefix stays constant across threads.

#### Scenario: The definition is a singleton with a stable prompt
- **WHEN** the assembly builds the agent and two threads resolve it
- **THEN** both threads get the identical definition, and the system prompt is byte-identical

#### Scenario: The two report agents stay distinct
- **WHEN** the old templating agent and this agent are both registered at boot
- **THEN** the two ids differ, and no registration point holds both under one id

### Requirement: The thread-keyed session runtime
The session runtime MUST bind the per-session state to the thread, behind the singleton definition. A session tool MUST read the thread id from `scope.threadId` at call time. A call whose scope carries no thread id MUST refuse as typed data in the ok channel. Two threads MUST never share a draft or a snapshot.

#### Scenario: Two threads hold two drafts
- **WHEN** two report threads each add a block through the same assembled agent
- **THEN** each thread's outline holds only its own block

#### Scenario: A scope without a thread id refuses
- **WHEN** a session tool runs with a scope that carries no `threadId`
- **THEN** the tool returns typed data that names the missing thread id, and it does not throw

### Requirement: The lazy snapshot mint
The runtime MUST mint the snapshot with `mintReportSnapshot` at the first call that needs it, one time for each thread. The runtime MUST write the minted snapshot into the session-state row of the thread. Every later call MUST read the stored snapshot, and it MUST NOT mint again. A mint failure MUST return as typed data, and a later call can mint again, because no row was written.

#### Scenario: The mint runs one time
- **WHEN** a thread makes two authoring calls
- **THEN** the artifact ledger query runs one time, and both calls read one snapshot

#### Scenario: The membership survives a restart
- **WHEN** the process restarts after the mint, and a new artifact lands in the ledger
- **THEN** the next call reads the stored snapshot, and the new artifact is not a member

#### Scenario: A mint failure does not poison the thread
- **WHEN** the first mint fails and the store recovers
- **THEN** the next call mints again, and the session continues

### Requirement: The session state is durable for each thread
The in-progress document and the pinned snapshot of a thread MUST live in one durable session-state row, keyed by the thread id. A landed operation MUST persist the document before it reports `applied: true`. A process restart and a replica change MUST NOT lose a landed operation. A purge of the analysis MUST remove the session-state rows of its threads.

#### Scenario: A restart keeps the document
- **WHEN** the process restarts after a thread composed three blocks
- **THEN** the next read on that thread gives the outline with the three blocks

#### Scenario: A second process sees the landed operation
- **WHEN** one process lands an add, and a different process serves the next turn
- **THEN** the outline of the next turn holds the added block

### Requirement: The read-only roster
The roster of the agent MUST hold: the four workspace read tools, the workspace search, `inspect_run`, `inspect_data_profile`, the authoring tools, and the render-and-preview tool. The roster MUST NOT hold a planner, a run launcher, a working-memory write, or a sandbox mutate surface. Thus no tool starts a run, and no tool changes an analysis.

#### Scenario: The roster holds no run starter
- **WHEN** the assembled agent lists its tools
- **THEN** no tool id of the run-starter set or the mutate set is present

#### Scenario: The analysis read surface is present
- **WHEN** the assembled agent lists its tools
- **THEN** the workspace read tools, the search, the run inspection, and the data-profile inspection are present

### Requirement: The render-and-preview tool
The preview tool MUST run the finish on the draft first. A gap list MUST return as data, and no render runs. On a pass, the tool MUST resolve each reference through the injected `ReferenceResolver`, bridge the values, render with `renderReportPage`, and publish through `PreviewPublisher`. An unresolved reference, a resolver absence, and an unavailable publisher MUST each return a typed outcome that names the cause. The tool MUST NOT throw for any of these outcomes.

#### Scenario: An unfinished draft returns the gaps
- **WHEN** the agent calls the preview on a draft with an empty section
- **THEN** the result carries the gap list, and no page publishes

#### Scenario: An unavailable publisher degrades as data
- **WHEN** the render passes and the publisher realization is unavailable
- **THEN** the result names the publisher absence, and the rendered page is not lost as an error

### Requirement: The value bridge
A pure module beside the renderer MUST map resolved values onto `RenderValues`: a scalar to a metric value, rows to a table, and a file echo to a figure source through a caller-supplied policy. The bridge MUST NOT read a file and MUST NOT resolve a reference itself.

#### Scenario: A file echo becomes a figure source
- **WHEN** the bridge maps a resolved file echo with a policy that builds a source string
- **THEN** the figure entry carries the policy result as its `src`

#### Scenario: A value type mismatch is a bridge refusal
- **WHEN** a table block's reference resolves to a scalar
- **THEN** the bridge returns typed data that names the block and the mismatch

### Requirement: The prompt obligations
The prompt of the agent MUST name its tools and their mechanisms, and it MUST NOT name a dataset, a path, or a format. The prompt MUST carry an explicit "Do NOT" list with the failure modes of report composition. The prompt MUST state that the agent grounds each claim through a reference, and that it does not transcribe a number from memory.

#### Scenario: The prompt stays free of environment detail
- **WHEN** a reviewer reads the prompt module
- **THEN** no dataset name, no path, and no format promise is present
