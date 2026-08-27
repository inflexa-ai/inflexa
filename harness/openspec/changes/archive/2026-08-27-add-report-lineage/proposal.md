# Add report lineage

## Why

A report cites artifacts, but a reader cannot see how the raw data became a
figure or a claim (#318). The full history lives in the signed, CLI-owned
provenance document, outside the harness. This change keeps that boundary, and
it shows the chain in the rendered page.

## What Changes

- The harness emits report observation events through a new seam,
  fire-and-forget, like `emitProvenance`. The events cover the block
  operations, the derivations, the preview, and the record. The embedder lands
  them in the same analysis provenance document.
- A second seam gives the current provenance document and its attestation as
  opaque bytes. The preview writes them into the page assets as
  content-addressed script assets. A publish then copies them with the page.
- The renderer stamps the reference pin on each grounded block. A tsprov-based
  browser library, shipped as a static page asset, builds the graph and walks
  backward on demand. A clickable popover shows the chain of the block.
- The harness gains no provenance API dependency. The version store, the record
  gate, and the session state do not change.

## Capabilities

### New Capabilities

- `report-observation-seam`: the report observation events, their vocabulary,
  and the fire-and-forget seam that carries them to the embedder.
- `report-provenance-export`: the document source seam, and the export of the
  document and the attestation into the page assets.

### Modified Capabilities

- `report-render`: the reference keys on each grounded block, the lineage
  library in the asset manifest, and the lineage popover.
- `report-design-system`: the lineage popover is a component of the design
  system, and the design fixture covers it.

## Impact

- `src/app/report-session-runtime.ts` and `src/tools/report-session/`,
  `src/tools/report-authoring/` — the event emission and the document export.
- `src/report-render/` — the pin attributes, the asset manifest entry, the
  popover markup, the boot script, and the CSS.
- `src/runtime/assemble.ts` — the two optional composition values.
- Dependencies: one tsprov-family view library rides as a static page asset,
  like echarts and AG Grid. The harness imports no API from it.
- Separate changes in other trees: the view library in the tsprov repository,
  and the recorder events plus the seam realizations in the cli.
