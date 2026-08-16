# Proposal: retry-the-capture-at-the-viewport

## Why

The full-page screenshot of a tall report page can exceed what the browser environment can rasterize. In the second real session, seven looks failed with one protocol error, and the record gate then refused every version. The environment fix lands in the embedder. The harness still owes a degraded look, thus one oversized page never blocks the record path again.

## What Changes

- `capturePage` (`src/lib/page-capture.ts`) retries one time at the viewport alone when the full-page screenshot throws. The result then carries the coverage of the picture.
- `PageCapture` gains a `coverage` field: `"full"` or `"viewport"`. The full arm stays the default shape of every passing capture.
- The eyes tool (`src/tools/report-session/examine-page.ts`) passes the coverage through to the agent, thus the agent knows that the picture shows the window alone.
- A viewport look still stamps the seen hash, because the agent saw the current page. The record path stays open.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-verification`: the eyes-tool requirement gains the viewport fallback and the coverage marker.

## Impact

- Affected code: `src/lib/page-capture.ts`, `src/tools/report-session/examine-page.ts`, and their tests.
- The added field is additive, thus the preview-snapshot caller of the old path keeps its shape.
- The embedder half — the shared-memory allowance of the eyes container — is a separate cli change.
