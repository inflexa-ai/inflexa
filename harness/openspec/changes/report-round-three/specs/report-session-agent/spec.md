## MODIFIED Requirements

### Requirement: The render-and-preview tool
The preview tool MUST run the finish on the draft first. A gap list MUST return as data, and no render runs. On a pass, the tool MUST resolve each reference through the injected `ReferenceResolver`, bridge the values, and render with `renderReportPage`. The page and its staged assets MUST land in the session directory `report-sessions/{threadId}/` under the workspace root. The result MUST carry the page path as data. When the page lands, the tool MUST stamp the hash of the rendered document on the session state.

The hosted view of a session page is a later capability with its own URL space, and the result carries no access grant. An unresolved reference, a resolver absence, and a failed write MUST each return a typed outcome that names the cause. The tool MUST NOT throw for any of these outcomes.

The preview MUST stage each data-script payload and each table sidecar beside the page, in the pipeline that stages the figures. It MUST stage the script of each derivation that the document references as a content-addressed asset, from the script text of the record. It MUST place each manifest static under `assets/deps/`, and each report-side file at the `assets/` root. The stage MUST be authoritative over the assets directory: after the page lands, every file that the new page does not reference goes, and the `deps/` statics stay. Thus a removed block leaves no orphan, and the directory is exactly the page's closure.

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
