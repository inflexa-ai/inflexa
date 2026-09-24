## ADDED Requirements

### Requirement: The compaction block shows the progress and the divider

`MessageBlock` MUST render a compaction part through one compaction block. The block MUST render one of two forms:

- The status `running` renders one muted line: `Summarizing earlier conversation…`.
- A terminal status renders a divider: a full-width row with a horizontal rule on each side of a muted label.

The label of `done` is `Summarized earlier conversation`, then the tokens before and after, then the duration. The label of `failed` is `Could not summarize earlier conversation`. When the part carries the tokens after, the label of `failed` also says that the oldest turns left the context, with the two token figures.

The block MUST take each color from `theme` and each glyph from `GLYPHS`. It MUST format each token figure with `formatTokens()` and the duration with `Date.formatDuration`. It MUST separate the facts of a label with the shared separator.

An event entry whose only part is a compaction part MUST render the divider with no left rule. Thus the divider spans the transcript, as the mark between the summarized part of the conversation and the rest.

The design gallery MUST carry an exhibit of each form: running, done, failed with a drop, and failed with no drop.

#### Scenario: A running compaction shows one line

- **WHEN** a compaction part has the status `running`
- **THEN** the block shows `Summarizing earlier conversation…` in a muted color, and no rule

#### Scenario: A done compaction shows the divider

- **GIVEN** a compaction part with the status `done`, 162,000 tokens before, 14,000 tokens after, and a duration of 21 seconds
- **WHEN** the block renders
- **THEN** it shows a full-width rule with `Summarized earlier conversation`, the two token figures, and the duration

#### Scenario: A failed compaction with a drop names the drop

- **GIVEN** a compaction part with the status `failed` and the tokens after
- **WHEN** the block renders
- **THEN** the divider says that the summary failed and that the oldest turns left the context, with the two token figures

#### Scenario: The divider of a reload has no event rule

- **GIVEN** an event entry whose only part is a compaction part
- **WHEN** `MessageBlock` renders it
- **THEN** the divider renders with no left rule and no turn marker

#### Scenario: The label is legible on a light theme

- **GIVEN** the `github-light` theme
- **WHEN** the block renders each form
- **THEN** each span of the label resolves a theme color, and no span falls back to the white default
