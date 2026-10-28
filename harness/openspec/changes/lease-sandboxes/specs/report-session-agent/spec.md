## MODIFIED Requirements

### Requirement: The prompt limits the looks and the finish calls

Each look and each tool result stays in the context of each later request of the turn. Thus the prompt MUST teach a build loop with few looks and few finish calls. The prompt MUST state these rules:

- When the agent knows the content of a section, it adds the section with its atoms in one `add_block` call.
- After the first preview that passes, the agent looks at the whole page one time. It makes each repair that this look shows before it looks again.
- After a repair, the agent previews. Then it looks only at each block that it repaired, and it gives the block id to the look tool.
- The record accepts a look at one block of the current page.
- A `block` coverage holds the named block alone, and the rest of the page is absent from that look.
- The agent does not call `finish_draft` directly before a preview. The preview runs the same finish, and it gives the same gaps and warnings.
- An amend is the whole set of changes of one user request. The agent makes the whole amend, and then it runs the loop again.
- Before the agent names a column, it gives the path of the artifact to the listing tool. It takes the column name from the columns that the tool gives.

#### Scenario: The prompt teaches the short loop

- **WHEN** a reviewer reads the prompt module
- **THEN** the add of a whole section, the one look at the whole page, and the block look after a repair are present
- **AND** the rule against a finish before a preview, and the whole amend, are present

#### Scenario: The prompt names the block coverage

- **WHEN** a reviewer reads the prompt module
- **THEN** a `block` coverage names the rest of the page as absent from the look

#### Scenario: The prompt routes a column name through the path

- **WHEN** a reviewer reads the prompt module
- **THEN** the agent takes a column name from the listing tool, called with the path of the artifact

## ADDED Requirements

### Requirement: The read-only roster holds no sandbox tool
The roster of the agent MUST hold: the workspace read tools (`read_file`, `list_files`, `file_stat`, and `grep`), the workspace search, `inspect_run`, `inspect_data_profile`, the authoring tools, the pinned-artifact listing tool, and the render-and-preview tool. The roster MUST NOT hold a planner, a run launcher, a working-memory write, or a sandbox mutate surface. Thus no tool starts a run, no tool changes an analysis, and no tool starts a sandbox.

With no input, the listing tool MUST give the pinned artifacts in a deterministic order: the path and the file type of each artifact. For a `.csv` or a `.tsv` artifact, the entry also gives the count of the header columns, from a bounded read of the header. The listing MUST also give the pinned citation ids. The listing is bounded, and a truncated listing MUST carry the total count and a truncation marker.

The listing MUST NOT give a hash, because a reference names the path alone and the session stamps the hash. The listing MUST NOT give the names of the columns. A wide table can have hundreds of columns, and the listing stays in the context of each later request.

With a `path`, the listing tool MUST give that one artifact with the outcome `artifact`: the path, the file type, the count of the header columns, and their names. A path that the pin does not hold MUST give the outcome `not-pinned`, with the path. A header that the bounded read cannot parse whole gives no columns and no count. An unreadable header gives no columns and no error, because absence is a normal condition.

The listing MUST give each pinned citation as its key with the short citation beside it, when the pinned record carries one. Thus the agent reads which id is which paper, and it composes a citation block with no guess. A key with no record lists bare, because absence is a normal condition.

#### Scenario: The roster holds no run starter
- **WHEN** the assembled agent lists its tools
- **THEN** no tool id of the run-starter set or the mutate set is present

#### Scenario: The analysis read surface is present
- **WHEN** the assembled agent lists its tools
- **THEN** the workspace read tools, the search, the run inspection, and the data-profile inspection are present

#### Scenario: The listing gives the pinned set with columns
- **WHEN** the agent calls the listing tool with no input, in a session whose snapshot pins a CSV artifact
- **THEN** the entry carries the path, the file type, and the count of the header columns, and no hash and no column name

#### Scenario: A path gives the header columns
- **WHEN** the agent calls the listing tool with the path of a pinned CSV artifact
- **THEN** the outcome is `artifact`, with the path, the file type, the count of the header columns, and their names

#### Scenario: A path outside the pin gives not-pinned
- **WHEN** the agent calls the listing tool with a path that the snapshot does not pin
- **THEN** the outcome is `not-pinned`, with that path

#### Scenario: An unreadable artifact still lists
- **WHEN** the snapshot pins a path whose bytes are absent from the disk
- **THEN** the result carries the path, with no columns, no count, and no error

#### Scenario: A large pinned set truncates with a marker
- **WHEN** the snapshot pins more artifacts than the listing bound
- **THEN** the result carries the bounded listing, the total count, and the truncation marker

#### Scenario: The listing names the paper beside the key
- **WHEN** the agent calls the listing tool in a session whose pin records `Hugo et al. 2016` under `pmid:26997480`
- **THEN** the listed citation carries the key and the short citation

#### Scenario: The roster holds no sandbox tool
- **WHEN** the assembled agent lists its tools
- **THEN** no tool runs a command in a sandbox, and `derive_table` is not present

### Requirement: The render-and-preview tool stages the closure of the page
The preview tool MUST run the finish on the draft first. A gap list MUST return as data, and no render runs. On a pass, the tool MUST resolve each reference through the injected `ReferenceResolver`, bridge the values, and render with `renderReportPage`. The page and its staged assets MUST land in the session directory `report-sessions/{threadId}/` under the workspace root. The result MUST carry the page path as data. When the page lands, the tool MUST stamp the hash of the rendered document on the session state.

When the composition binds the session-page publisher, the tool MUST mint one grant after the page lands, and the `rendered` arm MUST carry the URL of the space `report-sessions/{analysisId}/{threadId}` beside the page path. A refused mint MUST ride the arm as data, and it MUST NOT fail the render. An unbound publisher MUST change nothing: the arm carries the path alone. An unresolved reference, a resolver absence, and a failed write MUST each return a typed outcome that names the cause. The tool MUST NOT throw for any of these outcomes.

The preview MUST stage each data-script payload and each table sidecar beside the page, in the pipeline that stages the figures. It MUST place each manifest static under `assets/deps/`, and each report-side file at the `assets/` root. The stage MUST be authoritative over the assets directory: after the page lands, every file that the new page does not reference goes, and the `deps/` statics stay. Thus a removed block leaves no orphan, and the directory is exactly the page's closure.

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

#### Scenario: The statics group under deps
- **WHEN** the preview stages the page assets
- **THEN** each library and each font sits under `assets/deps/`, and each report-side file sits at the `assets/` root

#### Scenario: The stage removes what nothing references
- **WHEN** a block goes and the next preview runs
- **THEN** the stale data asset and the stale sidecar are gone, and the `deps/` statics stay

### Requirement: The prompt obligations of report composition
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
- a raster figure whose data sits in a pinned table
- a statistic baked inside an image
- a caption that promises what the plot does not show

A found fault is a repair, and never a note.

The prompt MUST teach the sliced look. A tall page arrives as consecutive top-to-bottom slices of the same page, in document order, and the agent reads the slices as one page. The prompt MUST state plainly that a truncated coverage — fewer captured pixels than total pixels — means the tail of the page was not seen: absent from the look, and not from the page. The prompt MUST state that only a whole look — one full shot, or slices that captured every pixel — makes an unseen section a real fault; under a partial look the agent judges what the pictures show and leaves the rest of the draft as it stands.

The prompt MUST name the listing tool as the orientation source for the pinned evidence. It MUST state that a reference names the path alone, and that the session stamps the hash. The "Do NOT" list MUST name the hash probe: the agent never guesses a hash, it never types one, and it never adds a block to read a hash from a refusal.

The prompt MUST state that the literature references compose as citation blocks, against the citation ids of the pinned evidence. It MUST name the listing tool as the route to the pinned citation ids. It MUST state that a citation outside the pinned evidence does not resolve, and that the agent reports it instead of an inline workaround. The agent builds no References section: a citation block sits beside the content it supports, and the References appendix is the list.

The prompt MUST carry the narrative spine. Before the first block, the agent composes the argument outline: the question, the approach, the findings in order of strength, the negative result in its honest place, the interpretation, and the limits. The flow of a paper, without the chapter names. No table and no chart appears before the sentence that tells the reader what to see in it. The summary mirrors the spine, and the angle of the brief decides the order. Each section opens with its topic sentence.

The prompt MUST carry the chart-first rule: prefer a chart block when a table artifact holds the data, and reach for a figure image only when no table does.

The prompt MUST carry the headline obligations. The headline row leads with the cohort and the yield. When the pinned evidence gives no cohort value, the headline leads with what the evidence gives, and the agent says so. A caveated value is not a headline. A summary of fewer than three cards names why. The card set carries its own contrast, and the prose rounds to the short form that the look confirms.

The prompt MUST carry the second-session obligations:

- The agent never transcribes a zero p-value into a sentence. It writes that the value sits below the resolution of the test, and the page renders the honest bound.
- The agent names a gene set in reader words, and the raw token stays in the table and the appendix.
- The named case of the chart-first rule is an obligation with an artifact test. A pinned ranked-set table takes the horizontal bar. A busy category set is not an exemption, because the horizontal bar exists for that shape.
- The agent quotes a number as the page prints it, and the look confirms the agreement.
- A metric binds a numeric cell, and an enumeration of three or more parallel points composes as the typed list.
- The agent declares the column meanings and the display labels on a table binding, and it sets the row bound on a large table.
- The bound has two sizes. A tight bound serves an evidence table, and a wide bound serves a browsable table. The data rides an asset, thus a wide bound costs the page nothing.
- The agent settles the add arguments before the call, thus no block lands as a probe.

The "Do NOT" list MUST name the zero-p transcription, the raw-token prose, and the hand-built reference section.

#### Scenario: The prompt teaches the zero-p rule
- **WHEN** a reviewer reads the prompt module
- **THEN** the zero-p transcription is a named fault, with the below-resolution phrasing as the alternative

#### Scenario: The prompt teaches the named chart case as an obligation
- **WHEN** a reviewer reads the prompt module
- **THEN** the ranked-set case carries its artifact test, and the busy-category exemption is refused in words

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

#### Scenario: The prompt teaches the sliced look
- **WHEN** a reviewer reads the prompt module
- **THEN** the sliced look reads as one page in document order, and a truncated coverage names the unseen tail as absent from the look and not from the page

## REMOVED Requirements

### Requirement: The session derivation

**Reason**: The report session loses `derive_table`. The tool was a sandbox consumer of a chat turn, and its request session cannot go into the input of a lease workflow. The report refactor removes the tool too.

**Migration**: A report binds the pinned artifacts only. The session state gets no new derivation record, and the `derived/` directory of a session goes away.

### Requirement: The read-only roster

**Reason**: The requirement drops the derivation tool. A MODIFIED block cannot drop a scenario, thus the requirement continues under a new name.

**Migration**: Refer to the ADDED requirement "The read-only roster holds no sandbox tool".

### Requirement: The render-and-preview tool

**Reason**: The requirement drops the stage of a derivation script. A MODIFIED block cannot drop a scenario, thus the requirement continues under a new name.

**Migration**: Refer to the ADDED requirement "The render-and-preview tool stages the closure of the page".

### Requirement: The prompt obligations

**Reason**: The requirement drops the derivation from the chart obligations. A MODIFIED block cannot drop a scenario, thus the requirement continues under a new name.

**Migration**: Refer to the ADDED requirement "The prompt obligations of report composition".
