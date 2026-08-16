# Proposal: stage-the-table-data-assets

## Why

The session page stamps 14,201 table rows into its markup, and `index.html` weighs 7.2 MB. A `fetch` is refused on a `file://` page, thus a data file cannot load the way an image does. A classic script asset loads fine, and the page already carries ECharts that way. The decided direction: the page stays `file://`-first, with classic script assets alone.

## What Changes

- The renderer emits the bound table of each table block as a columnar data-script payload: a columns list, row arrays, and a dictionary pass for repeated strings. The page markup holds the table header and no data rows, and a classic `script` tag references the asset.
- The renderer stays pure: it returns the payloads beside the page string, and the preview tool writes them, in the same pipeline that stages the figures.
- The table binding gains an optional row bound as content: the top N rows by a named column. The bound rows are the table, thus the asset, the render, and the gate see one bounded set.
- A raw CSV copy of each bound table stages beside the page, and the table card links it as the reader download.
- The asset stage of the preview is authoritative: it writes what the document references, and it removes what nothing references.
- A chart keeps its inline option, and a data asset past a compression threshold is a stated later arm.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-block-model`: the table binding carries the optional row bound.
- `report-render`: the table renders headers over a data asset, and the renderer returns the payloads.
- `report-session-agent`: the preview stages the data assets and the sidecars, and the stage is authoritative.

## Impact

- Affected code: `src/contracts/report-reference.ts`, `src/report-render/` (the table view, the render result, the assets), `src/tools/report-session/preview-report.ts`, the resolution path of the row bound, and their tests.
- The page loses its DOM rows before the grid child lands. The interim table shows its header and the download link, and the pairing closes in the next change of the tracker.
