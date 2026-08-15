# report-session-agent Specification

## Purpose

Define the Report Builder agent and its report-session runtime. The agent is the
one interactive owner of a report thread, and it composes a grounded block
document in conversation with the user. It reads the analysis, and it cannot run
or change one.

The per-session state is the in-progress document and the pinned snapshot. It
lives in one durable row for each thread, behind the singleton definition. Thus
one assembled agent serves every report thread, across restarts and replicas.

The old templating agent keeps its own id and its own file until its removal.
The two agents never share a registration point, and the session directory stays
off the namespaces of the old path.

## Requirements

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

### Requirement: The session state is durable for each thread
The in-progress document and the pinned snapshot of a thread MUST live in one durable session-state row, keyed by the thread id. A landed operation MUST persist the document before it reports `applied: true`. A process restart and a replica change MUST NOT lose a landed operation. A purge of the analysis MUST remove the session-state rows of its threads.

#### Scenario: A restart keeps the document
- **WHEN** the process restarts after a thread composed three blocks
- **THEN** the next read on that thread gives the outline with the three blocks

#### Scenario: A second process sees the landed operation
- **WHEN** one process lands an add, and a different process serves the next turn
- **THEN** the outline of the next turn holds the added block

### Requirement: The read-only roster
The roster of the agent MUST hold: the workspace read tools (`read_file`, `list_files`, `file_stat`, and `grep`), the workspace search, `inspect_run`, `inspect_data_profile`, the authoring tools, the pinned-artifact listing tool, and the render-and-preview tool. The roster MUST NOT hold a planner, a run launcher, a working-memory write, or a sandbox mutate surface. Thus no tool starts a run, and no tool changes an analysis.

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

### Requirement: The render-and-preview tool
The preview tool MUST run the finish on the draft first. A gap list MUST return as data, and no render runs. On a pass, the tool MUST resolve each reference through the injected `ReferenceResolver`, bridge the values, and render with `renderReportPage`. The page and its staged assets MUST land in the session directory `report-sessions/{threadId}/` under the workspace root. The result MUST carry the page path as data. When the page lands, the tool MUST stamp the hash of the rendered document on the session state.

The hosted view of a session page is a later capability with its own URL space, and the result carries no access grant. An unresolved reference, a resolver absence, and a failed write MUST each return a typed outcome that names the cause. The tool MUST NOT throw for any of these outcomes.

#### Scenario: An unfinished draft returns the gaps
- **WHEN** the agent calls the preview on a draft with an empty section
- **THEN** the result carries the gap list, and no page lands

#### Scenario: The page path returns for a local host
- **WHEN** the render passes
- **THEN** the result carries the page path, and the page is on disk

#### Scenario: The session directory stays off the old namespaces
- **WHEN** the preview tool writes a page
- **THEN** no write touches `previews/` or `reports/`

#### Scenario: The stamp follows the page
- **WHEN** the preview writes the page
- **THEN** the session state holds the hash of the rendered document

### Requirement: The value bridge
A pure module beside the renderer MUST map resolved values onto `RenderValues`: a scalar to a metric value, rows to a table, and a file echo to a figure source through a caller-supplied policy. The policy of the preview tool MUST stage the bound image into `assets/` beside the page, and the `src` is that relative path. The bridge MUST NOT read a file and MUST NOT resolve a reference itself.

#### Scenario: A file echo becomes a figure source
- **WHEN** the bridge maps a resolved file echo with a policy that builds a source string
- **THEN** the figure entry carries the policy result as its `src`

#### Scenario: A value type mismatch is a bridge refusal
- **WHEN** a table block's reference resolves to a scalar
- **THEN** the bridge returns typed data that names the block and the mismatch

### Requirement: The prompt obligations
The prompt of the agent MUST name its tools and their mechanisms, and it MUST NOT name a dataset, a path, or a format. The prompt MUST carry an explicit "Do NOT" list with the failure modes of report composition. The prompt MUST state that the agent grounds each claim through a reference, and that it does not transcribe a number from memory.

The prompt MUST teach the verification loop: preview, look, repair, and record only after a look at the current page. The "Do NOT" list MUST name the visual spiral. The agent does not loop on a cosmetic doubt, and it records when the page reads clean.

The look step MUST carry the fault checklist. The agent examines the picture for these faults:

- clipped text, and a truncated number
- an overflowing card
- a raw column name on an axis
- an unreadable precision
- content that stayed invisible
- a number in the prose that disagrees with its card

A found fault is a repair, and never a note.

The prompt MUST name the listing tool as the orientation source for the pinned evidence. It MUST state that a reference names the path alone, and that the session stamps the hash. The "Do NOT" list MUST name the hash probe: the agent never guesses a hash, and it never adds a block to read a hash from a refusal.

The prompt MUST state that the literature references compose as citation blocks, against the citation ids of the pinned evidence. It MUST name the listing tool as the route to the pinned citation ids. It MUST state that a citation outside the pinned evidence does not resolve, and that the agent reports it instead of an inline workaround.

The prompt MUST carry the narrative spine. Before the first block, the agent composes the argument outline: the question, the approach, the findings in order of strength, the negative result in its honest place, the interpretation, and the limits. The flow of a paper, without the chapter names. No table and no chart appears before the sentence that tells the reader what to see in it. The summary mirrors the spine, and the angle of the brief decides the order. Each section opens with its topic sentence.

The prompt MUST carry the chart-first rule: prefer a chart block when a table artifact holds the data, and reach for a figure image only when no table does.

The prompt MUST carry the headline obligations. The headline row leads with the cohort and the yield. When the pinned evidence gives no cohort value, the headline leads with what the evidence gives, and the agent says so. A caveated value is not a headline. The card set carries its own contrast, and the prose rounds to the short form that the look confirms.

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

#### Scenario: The prompt carries the fault checklist
- **WHEN** a reviewer reads the prompt module
- **THEN** the look step names the clipped text, the truncated number, the overflowing card, the raw axis name, and the precision fault

#### Scenario: The prompt carries the narrative spine
- **WHEN** a reviewer reads the prompt module
- **THEN** the spine order, the topic-sentence rule, and the evidence-after-its-sentence rule are present

#### Scenario: The prompt carries the chart-first rule
- **WHEN** a reviewer reads the prompt module
- **THEN** the chart-over-figure preference and its table condition are present

#### Scenario: The prompt carries the headline obligations
- **WHEN** a reviewer reads the prompt module
- **THEN** the cohort-and-yield lead, the caveated-value ban, and the rounding agreement are present

### Requirement: The report turn reads the copied narrative, never the live memory

The turn assembly of a `report` thread MUST NOT inject the live working-memory render. The seed message in the child transcript carries the copy at the anchor, and that copy is the narrative record of the session. A live render sees state past the anchor, and that breaks the knowledge cap.

The assembly MUST read the thread type from the row that the turn preparation already loads. A `conversation` thread keeps the live render.

#### Scenario: A report turn carries no live render

- **WHEN** a turn runs on a `report` thread
- **THEN** the assembled tail holds no working-memory render, and the seed message stays the one narrative source

#### Scenario: A conversation turn keeps the live render

- **WHEN** a turn runs on a `conversation` thread
- **THEN** the assembled tail holds the working-memory render, as before

### Requirement: The window of a report turn keeps the seed

The history window of a report turn MUST keep the first turn of the thread. The seed is that first turn, and it is the one record of the brief and of the working memory. No tail message replaces it.

The window evicts the oldest turn first. Thus a long session would drop the seed, and the agent would keep its tools and lose its objective. The retained seed can carry the window past its token budget. The cost is bounded, because the brief carries a length bound and the render is one row.

A `conversation` thread MUST keep the eviction that it has. The live tail of that thread carries the memory on each turn, thus its first turn holds no record that a later turn needs.

#### Scenario: A long report session keeps its seed

- **WHEN** a report thread holds more turns than the token budget admits
- **THEN** the window holds the seed, and it holds the most recent turns

#### Scenario: A conversation window evicts its oldest turn

- **WHEN** a conversation thread holds more turns than the token budget admits
- **THEN** the window drops the oldest turns, as before
