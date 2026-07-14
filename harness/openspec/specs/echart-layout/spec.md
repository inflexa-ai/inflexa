# echart-layout Specification

## Purpose

Define the layout discipline applied to every ECharts spec emitted through
`show_user(kind: "echart")`. The chart renders inside a card whose header is the
`show_user` `title` param, so without discipline elements collide: an in-spec
`title.text` duplicates the card header, a top legend overlaps it, dense category
labels get silently skipped by ECharts' `interval: "auto"`, and there is no way to
download the chart.

**The discipline is enforced in code, not asked of the agent.** `normalizeEchartSpec`
(`harness/src/tools/display/normalize-echart-spec.ts`) applies it deterministically,
and `buildPresentationCardData` (`harness/src/memory/card-builders.ts`) is where it
runs — the single construction site of a `PresentationContent`, so the live
`show_user` path and the reconstruct-on-read path (which sees only the persisted raw
`tool_use` input) produce a byte-identical card. A rule the model must remember on
every chart it composes is a rule it can forget; this one it cannot.

Two invariants govern every rule below:

1. **Defaults, not overrides.** A property is filled in only where the author left it
   unset. The two exceptions are forced: `title` (deleted — the card heading already
   renders it) and `axisLabel.interval` (pinned to `0` — ECharts' default `"auto"`
   silently drops labels, which is the exact bug the rule exists to prevent).
2. **Never turn a valid chart invalid.** Nothing is derived from data that may be
   absent: a `grid` is injected only for a cartesian chart, and an unknown category
   count yields the safe layout rather than a guessed one.

## Requirements

### Requirement: The harness normalizes every echart spec at card construction

The harness SHALL apply `normalizeEchartSpec` to the `spec` of every
`kind: "echart"` presentation card, inside `buildPresentationCardData` — not in the
`show_user` tool body, because the reconstruct-on-read path never runs the tool and
would otherwise render an un-normalized chart. Normalization SHALL be pure (the input
spec is never mutated; modified branches are copy-on-write) and idempotent:
`normalize(normalize(x))` SHALL deep-equal `normalize(x)`. The card `id` SHALL stay
keyed to the RAW tool input, so normalization cannot move a card's identity. Every
other card kind — and an `echart` the model called without a `spec` — SHALL pass
through untouched.

#### Scenario: Live and replayed cards are identical

- **GIVEN** a `show_user(kind: "echart")` call rendered live and the same card later reconstructed from the persisted `tool_use` input
- **WHEN** both cards are compared
- **THEN** their normalized specs SHALL be identical, and their `id`s SHALL match

#### Scenario: Normalization is idempotent

- **WHEN** an already-normalized spec is normalized again
- **THEN** the result SHALL deep-equal the input

#### Scenario: A non-echart card is not touched

- **WHEN** a `markdown` or `table` presentation card is built
- **THEN** its content SHALL be carried through unchanged

### Requirement: The in-spec title is stripped

The harness SHALL delete the `title` property from every echart spec, always — the
`show_user` `title` param is the card heading, so an in-spec title is a genuine
duplicate render. The stripped `title.text`, when it is a string, SHALL survive only
as a fallback seed for the download filename.

Because the whole `title` object is stripped, `title.subtext` is not a place to put
anything. The `show_user` tool description SHALL direct the agent to omit `title` and
to carry summary statistics in `tooltip.formatter`, a `graphic` text element, or a
separate `show_user(kind: "markdown")` call.

#### Scenario: An authored title is removed

- **WHEN** a spec carrying `title: { text: "Gene Expression", subtext: "padj < 0.05" }` is normalized
- **THEN** the output SHALL have no `title` property, and the `subtext` SHALL be gone with it

### Requirement: The legend defaults by series count

When the author left `legend` unset (`undefined` or `null`), the harness SHALL default
it from the declared series count: 2 or more series → `{ bottom: 0 }`; exactly one
series → `{ show: false }` (nothing to disambiguate, and an explicit hide stops a
themed legend component reintroducing an orphan swatch); zero declared series → no
`legend` key at all, since there is nothing to show or hide. An authored `legend` SHALL
be left exactly as written.

#### Scenario: Multi-series chart gets a bottom legend

- **WHEN** a spec with two series and no `legend` is normalized
- **THEN** the output SHALL carry `legend: { bottom: 0 }`

#### Scenario: Single-series chart hides the legend

- **WHEN** a spec with one series and no `legend` is normalized
- **THEN** the output SHALL carry `legend: { show: false }`

#### Scenario: An authored legend is respected

- **WHEN** a spec already carrying `legend: { top: 10 }` is normalized
- **THEN** the legend SHALL be left unchanged

### Requirement: Axis labels always show, and the x axis rotates by category count

The harness SHALL pin `axisLabel.interval` to `0` on every entry of `xAxis` and
`yAxis` — overriding any authored value — so ECharts shows every label instead of
silently skipping some. On the **x axis only**, and only when the author set no
`axisLabel.rotate`, it SHALL default the rotation from the derived category count:
`≤10` (or an underivable count) → no rotation; `11–20` → `45`; `>20` → `90`. Rotation
SHALL NOT cross to the y axis — turning a horizontal bar chart's category labels on
their side would be actively wrong — while `interval` SHALL, where it is inert on a
value axis and prevents silent skipping on a category one. A malformed axis entry
SHALL be passed through rather than dropped: normalization rewrites layout, never the
shape of the spec it was handed.

The category count SHALL be derived from an explicit `xAxis.data` array when present,
otherwise from `dataset.source`'s row count minus its header rows (per ECharts'
`sourceHeader` rules). It SHALL be `null` — meaning "do not guess a rotation" — for an
array of datasets, an object-of-columns `source`, a `seriesLayoutBy: "row"` series, or
a `dataPath`-backed spec whose rows the host loads at render time and which are
therefore not in the spec at all. The count is used ONLY to pick a rotation and never
touches the data, so a boundary miscount costs at most a rotation, never a rendering.

#### Scenario: Every label is shown

- **WHEN** any spec with an `xAxis` is normalized
- **THEN** each axis entry SHALL carry `axisLabel.interval: 0`

#### Scenario: 8 categories stay horizontal

- **WHEN** a spec whose `xAxis.data` holds 8 categories is normalized
- **THEN** no `axisLabel.rotate` SHALL be injected

#### Scenario: 15 categories rotate 45°

- **WHEN** a spec whose `xAxis.data` holds 15 categories is normalized
- **THEN** the x axis SHALL carry `axisLabel.rotate: 45`

#### Scenario: 25 categories rotate 90°

- **WHEN** a spec whose `xAxis.data` holds 25 categories is normalized
- **THEN** the x axis SHALL carry `axisLabel.rotate: 90`

#### Scenario: An unknown category count is not guessed

- **WHEN** a `dataPath`-backed spec (no `xAxis.data`, no `dataset.source`) is normalized
- **THEN** no rotation SHALL be injected, and `axisLabel.interval: 0` SHALL still be set

#### Scenario: An authored rotation wins

- **WHEN** a 25-category spec already sets `axisLabel.rotate: 30`
- **THEN** the rotation SHALL be left at `30`

### Requirement: Grid margins are defaulted for cartesian charts

For a cartesian chart (one carrying `xAxis` or `yAxis`), the harness SHALL fill only
the unset keys of `grid`: `top` `"8%"`, or `"12%"` when a `graphic` annotation shares
the canvas; `bottom` `"20%"`, `"25%"` when the x labels were rotated, or `"30%"` when
rotated above a bottom legend; `left` `"10%"`; `right` `"5%"`. It SHALL leave the grid
alone entirely for a non-cartesian chart (pie, sunburst, graph — there is no grid to
lay out), for an array of grids, and for a grid the author sized explicitly with
`width` or `height`, where an added margin could over-constrain the box.

#### Scenario: Rotated labels above a bottom legend get the deepest margin

- **WHEN** a multi-series 25-category cartesian spec with no authored grid is normalized
- **THEN** `grid.bottom` SHALL be `"30%"`

#### Scenario: Horizontal labels, single series

- **WHEN** an 8-category single-series cartesian spec with no authored grid is normalized
- **THEN** `grid.bottom` SHALL be `"20%"`, `grid.top` `"8%"`, `grid.left` `"10%"`, `grid.right` `"5%"`

#### Scenario: A pie chart gets no grid

- **WHEN** a spec with no `xAxis` and no `yAxis` is normalized
- **THEN** no `grid` SHALL be injected

#### Scenario: An explicitly sized grid is left alone

- **WHEN** the authored `grid` carries `width` or `height`
- **THEN** no margin SHALL be added to it

### Requirement: A save-as-image toolbox is injected

The harness SHALL inject `toolbox.feature.saveAsImage` with `type: "png"` and a
kebab-case `name`, filling only what the author left unset. The filename SHALL be
derived from the `show_user` `title` param, falling back to the stripped in-spec
`title.text`, then to `"chart"`. Placement `right: 0, top: 0` SHALL be added only when
the author declared no placement of their own (`left`/`right`/`top`/`bottom`) —
adding one on top of an authored placement would fight it. An array-valued `toolbox`
SHALL be left alone.

#### Scenario: Filename derives from the card title

- **WHEN** `show_user(kind: "echart", title: "HMGCR — VST Expression")` is normalized
- **THEN** `toolbox.feature.saveAsImage` SHALL be `{ type: "png", name: "hmgcr-vst-expression" }`

#### Scenario: No title anywhere falls back to "chart"

- **WHEN** a spec with no `show_user` title and no in-spec title is normalized
- **THEN** `saveAsImage.name` SHALL be `"chart"`

#### Scenario: An authored toolbox placement is respected

- **WHEN** the authored `toolbox` already sets `left: 20`
- **THEN** `right: 0, top: 0` SHALL NOT be added

### Requirement: Two layout rules are deliberately not normalized

The harness SHALL NOT add a `dataZoom` slider for a high-category chart, and SHALL NOT
abbreviate long category labels. Both are deliberate omissions, not gaps:

- A `dataZoom` slider is ECharts' own escape hatch above ~20 categories, but injecting
  one rewrites the chart's interaction model and its vertical budget. A 90° rotation is
  the mutation that cannot surprise, so that is what `>20` categories get. An agent that
  genuinely wants a slider SHALL author one; normalization leaves it in place.
- Abbreviating labels over ~15 characters requires an `axisLabel.formatter` **function**,
  which cannot be expressed in a JSON spec — the only representation `show_user` carries.
  There is nothing for the normalizer to write, so label length is left to the author, who
  can shorten the category values themselves.

#### Scenario: No slider is injected above 20 categories

- **WHEN** a 25-category spec with no `dataZoom` is normalized
- **THEN** the output SHALL carry no `dataZoom`, and the x labels SHALL be rotated 90° instead

#### Scenario: Long labels are not rewritten

- **WHEN** a spec whose category labels exceed 15 characters is normalized
- **THEN** no `axisLabel.formatter` SHALL be injected and the labels SHALL be left verbatim

### Requirement: Artifact-sourced data goes through dataPath, not inline rows

The agent SHALL chart data that already exists as a chart-ready artifact (e.g.
a CSV a sandbox step wrote) by referencing it via `show_user`'s `dataPath`
param instead of reading the file and inlining its rows into the spec. The
spec SHALL omit `dataset.source` and author `encode` and dimension references
against the artifact's column names (read from the CSV header — the agent
never needs the data rows). Inline data remains appropriate only for small,
just-computed values that exist nowhere as an artifact. When the raw data is
not chart-ready (needs aggregation, filtering, reshaping), the preparation
belongs in a sandbox step that writes a chart-ready CSV — not in the spec and
not in the agent's context window.

This one remains an agent obligation because no renderer can supply it: the choice to
push rows through the model's context window instead of naming the artifact is made
before the spec exists.

#### Scenario: Charting a step output

- **GIVEN** a run step wrote `runs/run-abc/step-2/output/de-summary.csv` with header `gene,log2FC,padj`
- **WHEN** the agent charts it
- **THEN** the agent calls `show_user(kind: "echart", dataPath: "runs/run-abc/step-2/output/de-summary.csv")` with a spec encoding `x: "log2FC"`, `y: "padj"` and no `dataset.source`

#### Scenario: Small computed values

- **WHEN** the agent charts a handful of numbers it just derived in conversation (no artifact exists)
- **THEN** an inline `dataset.source` in the spec is appropriate and `dataPath` is omitted
