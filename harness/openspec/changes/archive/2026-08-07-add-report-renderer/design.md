## Context

The old path renders agent-authored markup. `renderReport` (`src/execution/report-render.ts`) loads `report.html.j2` from the version directory through Nunjucks, with autoescape off, and it writes `index.html` itself. The gate (`src/tools/report/submit-report.ts`) then polices the symptoms: an empty page, an unrendered marker, and an asset reference that does not resolve.

The template pack (`templates/report-html/`) holds the page skeleton, seven components, `theme.css`, and the ECharts theme. The page pulls Tailwind, ECharts, and the fonts from a pinned CDN with SRI hashes. A deterministic chart-spec normalizer exists with its own spec: `normalizeEchartSpec`, under the `echart-layout` capability.

The new inputs exist since #305 and #306: `finish_draft` gives a valid `ReportDocument`, and the resolver seam gives a `ResolvedValue` for each reference.

## Goals / Non-Goals

**Goals:**

- A pure render function from a document and its values to one HTML string.
- A rendered form for each of the eight block kinds.
- Deterministic bytes: the same document and the same values give the same output.
- Escaping that the renderer owns, always on.
- Typed problems on the `Result` channel for a missing or mismatched value.

**Non-Goals:**

- The visual quality and the design system (#311). This change covers the mechanism.
- The value tier realization (#310). The caller supplies the values.
- The storage of a rendered page (#308) and the publisher that serves one.
- A change to the old render path, the gate, or the template pack.
- An offline, self-contained page. The CDN decision stays with #311.

## Decisions

### D1. The renderer is a pure string function

`renderReportPage(document, values)` returns `Result<string, RenderProblem[]>`. It reads no file, writes no file, and takes no directory. The old renderer does file I/O on both ends, and that shape forces a filesystem into every test. The caller decides where the bytes go: #308 stores them, and a publisher serves them.

### D2. No template engine in the new path

Each block kind renders through a TypeScript function, and a small escape helper wraps every interpolated string. A template engine adds an indirection that typed blocks do not need, and the old autoescape-off posture is the exact defect surface this change removes. The component classes and `theme.css` copy into the renderer source as constants, and the page inlines the CSS in a `<style>` block. Thus the output is one string with no local asset, and the missing-asset defect class is unrepresentable.

### D3. The value map is keyed by block id, and the caller adapts it

The renderer takes `Record<blockId, RenderValue>`. `RenderValue` is a closed union: a scalar, a table (the rows and the columns), a figure source string, and a citation echo. The caller maps each `ResolvedValue` onto it, and the caller computes the figure `src` (a data URI, or a URL that the host serves). Thus the renderer holds no policy about where image bytes live, and the seam to #310 stays one adapter.

A claim renders from its references alone (the pinned paths and the citation ids), thus a claim takes no value entry. A bound block with no value entry, or a value of the wrong shape, becomes a typed `RenderProblem`. The render collects every problem, and it returns them at once.

### D4. A chart derives its option object, and the discipline is reused

A chart block renders as a container div plus an inline option JSON, and the page script initializes ECharts on it. The option derives from `chartType`, the encoding, and the resolved rows, in one fixed construction order. The result runs through `normalizeEchartSpec`, thus the layout discipline of `echart-layout` applies without a second implementation. The div id derives from the block id, and the ECharts theme ships as a TypeScript constant in the renderer source.

The reference for the per-type shape is the dashboard chart dialog of the frontend repository. The table gives the rule for each type.

| Type | Encoding | The rule |
| --- | --- | --- |
| `bar` | `x`, `y`, optional `group` | A category x axis with the explicit `data` list. One bar series for each group, with the `[x, y]` pairs of that group. |
| `line` | `x`, `y`, optional `group` | The axis type infers per column: a category when any cell is a non-numeric string. Each series sorts by `x`, numerically when both cells are numbers. |
| `scatter` | `x`, `y`, optional `group` | The same axis inference as `line`, and no sort. The large-render flags stay on. |
| `histogram` | `x`, optional `group` | The renderer bins the `x` values into equal-width bins over the global range. Each bin renders as a bar at its midpoint, and the y value is the row count. Grouped series share the same edges. |
| `box` | `x`, `y`, optional `group` | The renderer computes the five-number summary for each category: type-7 quantiles, and Tukey fences at 1.5 IQR clamped to in-fence points. An outlier renders in a paired scatter series. A category with fewer than five values renders as an empty box. |
| `heatmap` | `x`, `y`, `value` | A dense grid over every pair of x and y categories, and an absent pair renders blank. A continuous viridis `visualMap` scales to the value range. |
| `pie` | `group`, `value` | One slice for each `group` category, and the magnitude comes from `value`. |

Five policies bind the table:

- **The bin count is automatic.** The count is the larger of the Sturges count and the Freedman-Diaconis count, as in NumPy `bins='auto'`. Sturges alone applies when the IQR is 0, and one bin applies when the range is 0.
- **The renderer computes no aggregate.** A pie or heatmap table arrives with one row for each category or cell, and `value` is required. A repeated category is a `RenderProblem`. Thus every plotted number stays traceable to a cell of the evidence artifact.
- **A missing demanded column is a `RenderProblem`.** Each type demands the encoding columns of its table row above.
- **The order is first appearance.** Category order and group order follow the first appearance in the rows, for every type. This diverges from the reference heatmap, which sorts, and it preserves a domain order such as Day1, Day2, Day10.
- **No legend and no toolbox from the derivation.** `normalizeEchartSpec` supplies the bottom legend and the save action. A category axis carries its explicit `data` list, thus the label-rotation rule of the discipline can read the count.

### D5. The page skeleton keeps the pinned CDN references

The skeleton emits the same pinned CDN and SRI references that the pack pins today: Tailwind, ECharts, and the fonts. The bytes stay deterministic, because the references are constants. A self-contained page inlines about one megabyte of ECharts, and that trade belongs to the design-system work. One rule protects the boundary: the renderer never reads `templates/report-html`, and its constants live in its own directory.

### D6. The rendered form of each kind

- A section renders as a heading by depth, with its children below. The top-level sections feed a fixed left sidebar, with one anchor for each section, targeted by its block id. This mirrors the sidebar of the current design (`templates/report-html/components/sidebar.html.j2`).
- A text block renders as paragraphs. A claim renders as paragraphs plus evidence markers, and the references list at the end of the page.
- A derivation reference lists as its operation with its two pinned inputs, each named by path and locator. The dedupe key of a reference is its stable serialization, thus two references are identical only when every field matches.
- A metric renders as a stat card with the label and the scalar value.
- A table renders every resolved row as an HTML table. The value tier bounds the size, and the renderer does not sample. A zero-row table renders its header from the columns, and no data row.
- A chart renders per D4. A zero-row chart renders its container, and the inline option holds an empty data list. A figure renders as an image with the supplied source and the caption. A citation renders as one entry in the reference list.

### D7. The determinism rules

No clock, no random value, and no locale formatting anywhere in the renderer. A scalar renders with `String(value)`. The walk order is the document order, and the evidence markers number by first appearance. The chart option JSON serializes from objects built in one fixed key order. Thus the same inputs give the same bytes, and a byte test can pin the output.

## Risks / Trade-offs

- [The page needs the network for Tailwind and ECharts] → accepted for this change. The self-containment call belongs to #311, and the pins carry SRI hashes.
- [A large resolved table inflates the page] → accepted. The value tier controls what resolution returns, and the renderer stays honest about every row.
- [Hostile prose breaks out of the markup] → the escape helper wraps every interpolation, and a test feeds hostile strings through every prose slot.
- [The adapted classes drift from the old look] → accepted. #311 owns the visual quality, and this change owns the mechanism.

## Migration Plan

The work is additive and dormant. No caller reaches the renderer, `src/index.ts` exports none of it, and no roster changes. A revert is one commit.

## Open Questions

- None. The exact class strings and the navigation shape are implementation details, and #311 revises them.
