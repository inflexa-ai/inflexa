# Delta: report-session-agent

## MODIFIED Requirements

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

The prompt MUST teach the sliced look. A tall page arrives as consecutive top-to-bottom slices of the same page, in document order, and the agent reads the slices as one page. The prompt MUST state plainly that a truncated coverage — fewer captured pixels than total pixels — means the tail of the page was not seen: absent from the look, and not from the page. The prompt MUST state that only a whole look — one full shot, or slices that captured every pixel — makes an unseen section a real fault; under a partial look the agent judges what the pictures show and leaves the rest of the draft as it stands.

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

#### Scenario: The prompt teaches the sliced look
- **WHEN** a reviewer reads the prompt module
- **THEN** the sliced look reads as one page in document order, and a truncated coverage names the unseen tail as absent from the look and not from the page
