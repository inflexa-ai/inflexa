# Design: stage-the-table-data-assets

## Context

The table view renders every resolved row into the markup, and the chart option rides as inline JSON. The preview tool stages the page, the static assets of the manifest, and the bound figures (`src/tools/report-session/preview-report.ts`). The renderer is pure: it reads no file and writes no file, and that rule stays.

## Decisions

### D1: The renderer returns the payloads, and the caller writes them

The render result gains a `dataAssets` list beside the page string: one entry for each bound table, with the asset file name and the payload bytes. The renderer stays pure and deterministic, and the preview tool writes each entry in the figure-staging pipeline. Two previews of one document give byte-identical payloads.

### D2: One payload is columnar, with a dictionary pass

The payload registers under one global map, keyed by the block id: `window.__REPORT_TABLES[<blockId>] = { columns, rows, dict }`. The rows are arrays in column order. A string that occurs more than one time in a column moves into `dict`, and the row cell holds its index. A number stays a number. The decode is a few lines in the page script, and the encode is deterministic: the dictionary orders by first appearance.

### D3: The asset name carries the content hash

The file is `assets/t-<hash12>.data.js`, the same content-address style as a staged figure. Thus two previews of unchanged data reuse one name, a changed table gets a new name, and the authoritative sweep removes the stale one.

### D4: The row bound is content on the binding

`rowBound: { column, count, order }` is optional on the whole-table binding, with `desc` as the default order. The resolution applies it: the resolved table holds the bounded rows, sorted by the named column with the numeric-aware compare. Thus the asset, the render, the gate, and a chart over the same binding see one bounded set. An unknown column in the bound refuses at the structural tier, exactly as a grammar column does.

### D5: The sidecar is the pinned bytes

The reader download is the raw artifact, not a re-serialization. The preview copies the pinned file beside the page as `assets/<hash12>-<basename>`, and the table card links it with a `download` attribute. A relative link is not a remote reference, thus the stands-alone rule holds untouched.

### D6: The sweep is authoritative over the assets directory

After a preview writes the page, it removes every file in `assets/` that the new page does not reference: a stale data asset, a stale figure, and a stale sidecar alike. The manifest statics always stay. Thus a removed block leaves no orphan, and the folder is exactly the page's closure.

### D7: The interim table shows the header and the download

The DOM rows go now, and the grid of the next tracker change consumes the registered data. Between the two changes, the table card holds the header row, the download link, and the data asset. The round-one enhancer becomes inert on an empty body, and its removal belongs to the grid change.

### D8: A chart keeps its inline option, and compression waits for its case

The chart data is bounded by what a chart can show, and moving it needs an option-to-dataset surgery with no present need. A data asset past a size threshold near 10 MB takes the gzip arm with a zeroed header when such a table appears. Both are stated later arms, not silent gaps.

## Risks / Trade-offs

- A block id rides into a JS identifier context. The id is safe-id constrained by the contract, and the payload writes it as a JSON string key, thus no injection surface opens.
- The interim page shows no rows in a plain browser until the grid lands. The pairing is one tracker sequence, and the delivery branch ships whole.
