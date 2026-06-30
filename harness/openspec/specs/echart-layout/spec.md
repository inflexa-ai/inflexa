# echart-layout Specification

## Purpose

Define the layout discipline the conversation agent applies when it emits an
ECharts chart via `show_user(kind: "echart")`. The chart renders inside a card
whose header is the `show_user` `title` param, and the `echarts-theme.json`
shipped with the report templates already hides the in-spec title, drops the
legend to the bottom, and registers a `saveAsImage` toolbox. Without matching
discipline in the spec the agent composes, elements collide: an in-spec
`title.text` duplicates the card header, a top legend overlaps the title, dense
category labels get silently skipped by ECharts, and there is no way to download
the chart. These rules — mirrored in the conversation agent prompt's "ECharts
Layout" section — keep agent-authored charts legible and downloadable. They are a
mental checklist the agent applies before the call, not a programmatic
validation.

## Requirements

### Requirement: No duplicate title between the card header and the spec

The agent SHALL NOT set `title.text` in the ECharts spec when a `show_user`
`title` is provided — that param renders as the card header above the chart
canvas, so an in-spec title duplicates it. Summary statistics or annotations
(e.g. a `log2FC`/`padj` callout) SHALL go in the `tooltip.formatter`, in a
`graphic` text element positioned clear of the chart area, or in a separate
`show_user(kind: "markdown")` call — never in `title.subtext`.

#### Scenario: Agent generates a chart with a show_user title

- **WHEN** the agent calls `show_user(kind: "echart", title: "Gene Expression")` with an ECharts spec
- **THEN** the ECharts spec SHALL NOT contain a `title` property

#### Scenario: Agent needs to show statistical annotations

- **WHEN** the agent wants to display summary statistics alongside a chart
- **THEN** the agent SHALL place them in the `tooltip.formatter` or a separate `show_user(kind: "markdown")` call, never as `title.subtext`

### Requirement: Legend placement below the chart area

The agent SHALL place the legend at the bottom of the chart (`legend: { bottom: 0 }`)
so it never collides with the title area. For a single-series chart the agent
SHALL omit the legend entirely (hide it or leave it out).

#### Scenario: Chart with multiple series

- **WHEN** the agent generates a chart with 2 or more named series
- **THEN** the ECharts spec SHALL include `legend: { bottom: 0 }`

#### Scenario: Chart with a single series

- **WHEN** the agent generates a chart with only one series
- **THEN** the ECharts spec SHALL omit the legend entirely

### Requirement: Grid margins accommodate all elements

The agent SHALL set explicit `grid` margins that leave room for axis labels,
legend, and any annotations. Minimum values:
- `grid.top`: `"8%"` (no annotation) or `"12%"` (with a `graphic` annotation)
- `grid.bottom`: `"20%"` (horizontal labels), `"25%"` (rotated labels), `"30%"` (rotated labels with a bottom legend)
- `grid.left`: `"10%"`
- `grid.right`: `"5%"`

#### Scenario: Chart with rotated x-axis labels and a bottom legend

- **WHEN** the agent generates a chart with rotated x-axis labels and a bottom legend
- **THEN** the ECharts spec SHALL set `grid.bottom` to at least `"30%"`

#### Scenario: Chart with horizontal x-axis labels and no legend

- **WHEN** the agent generates a chart with short horizontal labels and a single series
- **THEN** the ECharts spec SHALL set `grid.bottom` to at least `"20%"`

### Requirement: X-axis label strategy by category count

The agent SHALL always set `axisLabel.interval: 0` (so ECharts shows every label)
and choose the display strategy by category count:
- **≤10 categories**: horizontal labels, no rotation
- **11–20 categories**: `axisLabel.rotate: 45`, abbreviate labels longer than 15 characters
- **>20 categories**: `axisLabel.rotate: 90` and/or add a `dataZoom` slider

#### Scenario: Chart with 8 sample categories

- **WHEN** the agent generates a category-axis chart with 8 categories
- **THEN** the x-axis labels SHALL be horizontal (no rotation)

#### Scenario: Chart with 15 sample categories

- **WHEN** the agent generates a category-axis chart with 15 categories where some labels exceed 15 characters
- **THEN** the x-axis labels SHALL be rotated 45° and long labels SHALL be abbreviated

#### Scenario: Chart with 25 sample categories

- **WHEN** the agent generates a category-axis chart with 25 categories
- **THEN** the x-axis labels SHALL be rotated 90° or a `dataZoom` slider SHALL be included

### Requirement: Toolbox with save-as-image

Every ECharts spec SHALL include a `toolbox` with `saveAsImage` enabled so users
can download the chart as a PNG, positioned at `right: 0, top: 0` to stay out of
the chart area, with a descriptive kebab-case filename.

#### Scenario: Any ECharts chart

- **WHEN** the agent generates any ECharts spec
- **THEN** the spec SHALL include `toolbox: { feature: { saveAsImage: { type: "png", name: "<descriptive-filename>" } }, right: 0, top: 0 }`

#### Scenario: Download filename reflects chart content

- **WHEN** the agent generates a chart titled "HMGCR — VST Expression"
- **THEN** the `saveAsImage.name` SHALL be a descriptive kebab-case string (e.g. `"hmgcr-vst-expression"`)

### Requirement: Layout verification before emitting the chart

Before emitting a `show_user(kind: "echart")` call, the agent SHALL review the
spec against the layout rules: no `title.text` when a `show_user` title is set,
legend at bottom (or hidden for a single series), grid margins sufficient,
x-axis label strategy matching the category count, and a `saveAsImage` toolbox
present. This verification is a mental checklist, not a programmatic check.

#### Scenario: Agent composes an ECharts spec

- **WHEN** the agent has composed an ECharts option JSON and is about to call `show_user`
- **THEN** the agent SHALL review the spec against the layout rules before making the call
