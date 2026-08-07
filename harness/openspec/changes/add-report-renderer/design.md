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

### D5. The page skeleton keeps the pinned CDN references

The skeleton emits the same pinned CDN and SRI references that the pack pins today: Tailwind, ECharts, and the fonts. The bytes stay deterministic, because the references are constants. A self-contained page inlines about one megabyte of ECharts, and that trade belongs to the design-system work. One rule protects the boundary: the renderer never reads `templates/report-html`, and its constants live in its own directory.

### D6. The rendered form of each kind

- A section renders as a heading by depth, with its children below. The top-level sections also feed a small navigation list.
- A text block renders as paragraphs. A claim renders as paragraphs plus evidence markers, and the references list at the end of the page.
- A metric renders as a stat card with the label and the scalar value.
- A table renders every resolved row as an HTML table. The value tier bounds the size, and the renderer does not sample.
- A chart renders per D4. A figure renders as an image with the supplied source and the caption. A citation renders as one entry in the reference list.

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
