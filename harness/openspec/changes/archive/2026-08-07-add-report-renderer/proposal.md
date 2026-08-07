## Why

Today the builder agent writes a Nunjucks template, and the gate examines the result for symptoms: an empty page, an unrendered marker, an asset that does not resolve. Each check exists because an agent can write bad markup. A renderer that is a pure function of the block tree removes that class of defect, and this is the step that #307 tracks.

## What Changes

- Add a deterministic renderer. Its inputs are the `ReportDocument` and the values that resolution gives, keyed by block id. Its output is one HTML string.
- The renderer is pure: no file read, no file write, no clock, no random value. The same document and the same values give the same bytes.
- Add a rendered form for each of the eight block kinds. The renderer makes the layout decisions, and the agent makes none.
- Escaping is always on, and the renderer owns it. Agent prose flows into the page, and the old autoescape-off posture does not carry over.
- A chart block renders through client-side ECharts. The option object derives from the chart type, the encoding, and the resolved rows. The derivation runs through the same normalize discipline that the `echart-layout` capability defines.
- A figure block renders from a source string that the caller supplies in the value map. Thus the renderer stays free of the policy about where image bytes live.
- A missing or mismatched value returns typed problems on the `Result` channel. The renderer does not throw for an expected fault.
- The renderer gets its own directory with its own page skeleton and style assets. It never reads `templates/report-html`, and the old path stays live.

## Capabilities

### New Capabilities

- `report-render`: the pure render function, the value-map input contract, the rendered form of each block kind, the determinism rules, and the escaping rules.

### Modified Capabilities

<!-- none — the block model, the authoring surface, the snapshot, and the echart-layout discipline keep their requirements -->

## Impact

- New code under `harness/src/report-render/`: the render function, one module for each block kind or a small set of modules, and the copied style assets.
- Reads the block contract (`src/contracts/report-blocks.ts`), the resolved-value model (`src/report-model/reference-resolver.ts`), and `normalizeEchartSpec` (`src/tools/display/normalize-echart-spec.ts`).
- No new dependency. The new path does not use Nunjucks.
- The work is additive and dormant. No caller reaches the renderer, `src/index.ts` exports none of it, and no roster changes. The old render path (`src/execution/report-render.ts`) stays untouched.
