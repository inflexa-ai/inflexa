# Delta: report-session-agent

## MODIFIED Requirements

### Requirement: The prompt obligations
The prompt of the agent MUST name its tools and their mechanisms, and it MUST NOT name a dataset, a path, or a format. The prompt MUST carry an explicit "Do NOT" list with the failure modes of report composition. The prompt MUST state that the agent grounds each claim through a reference, and that it does not transcribe a number from memory.

The prompt MUST teach the verification loop: preview, look, repair, and record only after a look at the current page. The "Do NOT" list MUST name the visual spiral. The agent does not loop on a cosmetic doubt, and it records when the page reads clean.

The look step MUST carry the fault checklist. The agent examines the picture for: clipped text, a truncated number, an overflowing card, a raw column name on an axis, an unreadable precision, and content that stayed invisible. A found fault is a repair, and never a note.

The prompt MUST name the listing tool as the orientation source for the pinned evidence. It MUST state that a reference names the path alone, and that the session stamps the hash. The "Do NOT" list MUST name the hash probe: the agent never guesses a hash, and it never adds a block to read a hash from a refusal.

The prompt MUST state that the literature references compose as citation blocks, against the citation ids of the pinned evidence. It MUST name the listing tool as the route to the pinned citation ids. It MUST state that a citation outside the pinned evidence does not resolve, and that the agent reports it instead of an inline workaround.

The prompt MUST carry the narrative spine. Before the first block, the agent composes the argument outline: the question, the approach, the findings in order of strength, the negative result in its honest place, the interpretation, and the limits. The flow of a paper, without the chapter names. No table and no chart appears before the sentence that tells the reader what to see in it. The summary mirrors the spine, and the angle of the brief decides the order. Each section opens with its topic sentence.

The prompt MUST carry the chart-first rule: prefer a chart block when a table artifact holds the data, and reach for a figure image only when no table does.

The prompt MUST carry the headline obligations. The headline row leads with the cohort and the yield. A caveated value is not a headline. The card set carries its own contrast, and the prose rounds as the cards round.

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
