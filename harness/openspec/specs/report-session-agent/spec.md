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

### Requirement: The session tools name their calls
The report tools MUST give a call detail that names their subject. `add_block` names the kind, with the title of a section or the file name of a bound artifact. `change_block`, `move_block`, and `remove_block` name the block id. On an ok outcome, `preview_report` names the page path. `record_report_version` names the version on a creation, and it names the replacement on a later record. `examine_page` names the look outcome, and the listing tool names the listed count with the truncation.

#### Scenario: An added section names its title
- **WHEN** the agent adds a section block titled "Summary"
- **THEN** the call line reads the kind and the title

#### Scenario: An added table names its file
- **WHEN** the agent adds a table block bound to a workspace path
- **THEN** the call line reads the kind and the file name of the path

#### Scenario: The preview names the page
- **WHEN** the preview renders the page
- **THEN** the finished line names the page path

#### Scenario: A re-record names the replacement
- **WHEN** the agent records on a thread that holds a version
- **THEN** the call line names the update, and it does not read as a refusal

### Requirement: The read-only roster
The roster of the agent MUST hold: the workspace read tools (`read_file`, `list_files`, `file_stat`, and `grep`), the workspace search, `inspect_run`, `inspect_data_profile`, the authoring tools, the pinned-artifact listing tool, the derivation tool, and the render-and-preview tool. The roster MUST NOT hold a planner, a run launcher, a working-memory write, or a sandbox mutate surface. Thus no tool starts a run, and no tool changes an analysis. A session derivation is a sandbox exec inside the session: it mints no run id, it registers no artifact, and it writes under the session directory alone.

The listing tool MUST give the pinned artifacts in a deterministic order: the path, the hash, and the file type. It MUST also give the pinned citation ids. The listing is bounded, and a truncated listing MUST carry the total count and a truncation marker. For a `.csv` or a `.tsv` artifact it also gives the columns, from a bounded read of the header. A header that the bounded read cannot parse whole gives no columns. An unreadable header gives no columns and no error, because absence is a normal condition.

The listing MUST give each pinned citation as its key with the short citation beside it, when the pinned record carries one. Thus the agent reads which id is which paper, and it composes a citation block with no guess. A key with no record lists bare, because absence is a normal condition.

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

#### Scenario: The listing names the paper beside the key
- **WHEN** the agent calls the listing tool in a session whose pin records `Hugo et al. 2016` under `pmid:26997480`
- **THEN** the listed citation carries the key and the short citation

#### Scenario: A derivation starts no run
- **WHEN** the agent derives a table in a session
- **THEN** no run row and no artifact row lands, and the output sits under the session directory

### Requirement: The render-and-preview tool
The preview tool MUST run the finish on the draft first. A gap list MUST return as data, and no render runs. On a pass, the tool MUST resolve each reference through the injected `ReferenceResolver`, bridge the values, and render with `renderReportPage`. The page and its staged assets MUST land in the session directory `report-sessions/{threadId}/` under the workspace root. The result MUST carry the page path as data. When the page lands, the tool MUST stamp the hash of the rendered document on the session state.

When the composition binds the session-page publisher, the tool MUST mint one grant after the page lands, and the `rendered` arm MUST carry the URL of the space `report-sessions/{analysisId}/{threadId}` beside the page path. A refused mint MUST ride the arm as data, and it MUST NOT fail the render. An unbound publisher MUST change nothing: the arm carries the path alone. An unresolved reference, a resolver absence, and a failed write MUST each return a typed outcome that names the cause. The tool MUST NOT throw for any of these outcomes.

The preview MUST stage each data-script payload and each table sidecar beside the page, in the pipeline that stages the figures. It MUST stage the script of each derivation that the document references as a content-addressed asset, from the script text of the record. It MUST place each manifest static under `assets/deps/`, and each report-side file at the `assets/` root. The stage MUST be authoritative over the assets directory: after the page lands, every file that the new page does not reference goes, and the `deps/` statics stay. Thus a removed block leaves no orphan, and the directory is exactly the page's closure.

#### Scenario: An unfinished draft returns the gaps
- **WHEN** the agent calls the preview on a draft with an empty section
- **THEN** the result carries the gap list, and no page lands

#### Scenario: The page path returns for a local host
- **WHEN** the render passes
- **THEN** the result carries the page path, and the page is on disk

#### Scenario: The URL rides beside the path
- **WHEN** the render passes and the bound publisher grants
- **THEN** the `rendered` arm carries the page path and the URL of the session page

#### Scenario: A refused mint keeps the render
- **WHEN** the render passes and the bound publisher refuses
- **THEN** the `rendered` arm carries the page path, the refusal as data, and the page is on disk

#### Scenario: The session directory stays off the old namespaces
- **WHEN** the preview tool writes a page
- **THEN** no write touches `previews/` or `reports/`

#### Scenario: The stamp follows the page
- **WHEN** the preview writes the page
- **THEN** the session state holds the hash of the rendered document

#### Scenario: The data asset lands beside the page
- **WHEN** the preview renders a document with a bound table
- **THEN** the data-script asset and the raw sidecar sit under `assets/`, and the page references both

#### Scenario: The script of a referenced derivation lands
- **WHEN** the preview renders a document whose binding names a derived path
- **THEN** the script of that derivation sits under `assets/` as a content-addressed file, and the appendix chain links it

#### Scenario: The statics group under deps
- **WHEN** the preview stages the page assets
- **THEN** each library and each font sits under `assets/deps/`, and each report-side file sits at the `assets/` root

#### Scenario: The stage removes what nothing references
- **WHEN** a block goes and the next preview runs
- **THEN** the stale data asset, the stale sidecar, and the stale script are gone, and the `deps/` statics stay

### Requirement: The URL space of a session page
The `res` claim formula of a session page MUST be `report-sessions/{analysisId}/{threadId}`, with no leading slash and no trailing slash (`reportSessionResourceId` in `contracts/content-url.ts`). The URL of a served page MUST be `{contentBaseUrl}/report-sessions/{analysisId}/{threadId}/{pagePath}?t={token}`, with the token URL-encoded (`buildReportSessionUrl`). The TypeScript formulas and the Go mirrors of the storage backend MUST stay locked by the shared test vectors at `src/__tests__/fixtures/preview-res.json` and `src/__tests__/fixtures/report-session-res.json`, each a byte-identical copy of the storage backend's `kernel/contenttoken/testdata` file.

The claim carries the analysis id, because the URL needs an authorization boundary. On disk the page sits at `report-sessions/{threadId}/` under the workspace root, thus a host that serves the space owns the map between the two.

#### Scenario: The formula matches the shared vector
- **WHEN** the TypeScript formula runs over each report-session vector of the shared fixture
- **THEN** each result equals the recorded res of that vector

#### Scenario: The URL spells the res space
- **WHEN** `buildReportSessionUrl` composes a URL over a base, an analysis, a thread, a page path, and a token
- **THEN** the URL is the base, the res, and the page path, with the encoded token under the `t` query parameter

### Requirement: The session-page publisher seam
The composition MUST give the hosted view of a session page through one publisher seam. The mint operation takes the analysis id and the thread id, and it returns the grant or the typed refusal. A grant carries the base URL of the content server, the token, and the expiry — the caller spells the whole URL through `buildReportSessionUrl`, thus the formula lives in the contract and never in a realization. The local default MUST return the not-ok arm, thus a composition with no hosted surface stays on the page path.

#### Scenario: The local default refuses
- **WHEN** the unavailable publisher mints
- **THEN** the result is not-ok, and the message names the unavailable hosted view

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

The prompt MUST teach the verification loop: preview, look, repair, and record only after a look at the current page. The record loop is unbounded: the agent records again after each accepted amend, thus the stored version always equals the page. The "Do NOT" list MUST name the visual spiral. The agent does not loop on a cosmetic doubt, and it records when the page reads clean.

The look step MUST carry the fault checklist. The agent examines the picture for these faults:

- clipped text, and a truncated number
- an overflowing card
- a raw column name on an axis
- an unreadable precision
- content that stayed invisible
- a number in the prose that disagrees with its card
- a printed zero probability
- a raster figure whose data sits in a pinned or derivable table
- a statistic baked inside an image
- a caption that promises what the plot does not show

A found fault is a repair, and never a note.

The prompt MUST name the listing tool as the orientation source for the pinned evidence. It MUST state that a reference names the path alone, and that the session stamps the hash. The "Do NOT" list MUST name the hash probe: the agent never guesses a hash, it never types one, and it never adds a block to read a hash from a refusal.

The prompt MUST state that the literature references compose as citation blocks, against the citation ids of the pinned evidence. It MUST name the listing tool as the route to the pinned citation ids. It MUST state that a citation outside the pinned evidence does not resolve, and that the agent reports it instead of an inline workaround. The agent builds no References section: a citation block sits beside the content it supports, and the References appendix is the list.

The prompt MUST carry the narrative spine. Before the first block, the agent composes the argument outline: the question, the approach, the findings in order of strength, the negative result in its honest place, the interpretation, and the limits. The flow of a paper, without the chapter names. No table and no chart appears before the sentence that tells the reader what to see in it. The summary mirrors the spine, and the angle of the brief decides the order. Each section opens with its topic sentence.

The prompt MUST carry the chart-first rule: prefer a chart block when a table artifact holds the data, and reach for a figure image only when no table does.

The prompt MUST carry the headline obligations. The headline row leads with the cohort and the yield. When the pinned evidence gives no cohort value, the headline leads with what the evidence gives, and the agent says so. A caveated value is not a headline. A summary of fewer than three cards names why. The card set carries its own contrast, and the prose rounds to the short form that the look confirms.

The prompt MUST carry the second-session obligations:

- The agent never transcribes a zero p-value into a sentence. It writes that the value sits below the resolution of the test, and the page renders the honest bound.
- The agent names a gene set in reader words, and the raw token stays in the table and the appendix.
- The derive-and-chart rule extends the chart-first rule, and its two named cases are obligations with an artifact test. A pinned ranked-set table takes the horizontal bar. Pinned survival columns take the derived step table with the `km` preset. A busy category set is not an exemption, because the horizontal bar exists for that shape.
- When the headline scalars sit in no artifact, the agent derives the headline table first.
- The agent quotes a number as the page prints it, and the look confirms the agreement.
- A metric binds a numeric cell, and an enumeration of three or more parallel points composes as the typed list.
- The agent declares the column meanings and the display labels on a table binding, and it sets the row bound on a large table.
- The bound has two sizes. A tight bound serves an evidence table, and a wide bound serves a browsable table. The data rides an asset, thus a wide bound costs the page nothing.
- A model table reads best with a composed display column, and the agent can offer that small derivation.
- The agent settles the add arguments before the call, thus no block lands as a probe.

The "Do NOT" list MUST name the zero-p transcription, the raw-token prose, and the hand-built reference section.

#### Scenario: The prompt teaches the zero-p rule
- **WHEN** a reviewer reads the prompt module
- **THEN** the zero-p transcription is a named fault, with the below-resolution phrasing as the alternative

#### Scenario: The prompt teaches derive-and-chart as an obligation
- **WHEN** a reviewer reads the prompt module
- **THEN** the two named cases carry their artifact test, and the busy-category exemption is refused in words

#### Scenario: The prompt teaches the declaration and the bound
- **WHEN** a reviewer reads the prompt module
- **THEN** the column-meaning declaration, the display labels, the row bound, and the two bound sizes are named obligations

#### Scenario: The prompt bans the hand-built reference section
- **WHEN** a reviewer reads the prompt module
- **THEN** the References-section ban is present, and the citation-beside-content rule stands as the alternative

#### Scenario: The prompt stays free of environment detail
- **WHEN** a reviewer reads the prompt module
- **THEN** no dataset name, no path, and no format promise is present

#### Scenario: The prompt teaches the loop order
- **WHEN** a reviewer reads the prompt module
- **THEN** the loop order, the unbounded record loop, and the visual-spiral anti-pattern are present

#### Scenario: The prompt teaches the path-only rule
- **WHEN** a reviewer reads the prompt module
- **THEN** the listing tool is the named orientation source, and the hash-probe anti-pattern covers a typed hash

#### Scenario: The prompt teaches the citation blocks
- **WHEN** a reviewer reads the prompt module
- **THEN** the citation-block rule and the pinned-evidence bound are present

#### Scenario: The prompt carries the fault checklist
- **WHEN** a reviewer reads the prompt module
- **THEN** the look step names the raster-figure fault, the baked-statistic fault, and the caption-promise fault beside the earlier faults

#### Scenario: The prompt carries the narrative spine
- **WHEN** a reviewer reads the prompt module
- **THEN** the spine order, the topic-sentence rule, and the evidence-after-its-sentence rule are present

#### Scenario: The prompt carries the chart-first rule
- **WHEN** a reviewer reads the prompt module
- **THEN** the chart-over-figure preference and its table condition are present

#### Scenario: The prompt carries the headline obligations
- **WHEN** a reviewer reads the prompt module
- **THEN** the cohort-and-yield lead, the caveated-value ban, the three-card rule, and the rounding agreement are present

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
