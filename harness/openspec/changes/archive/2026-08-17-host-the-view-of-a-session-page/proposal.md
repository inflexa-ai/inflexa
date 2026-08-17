# Proposal: host-the-view-of-a-session-page

## Why

`preview_report` writes the page to `report-sessions/{threadId}/index.html`, and it returns the path. A local host opens the file, thus the CLI needs nothing. But the content-token space is fixed at `previews/{analysisId}/{previewId}` (`src/contracts/content-url.ts`), and that space cannot name a page of the session tree. Thus a managed user has no route to a session page. This is the contract half of inflexa#342; the serving half lands in the storage backend.

## What Changes

- A second `res` formula beside `previewResourceId`: `reportSessionResourceId` gives `report-sessions/{analysisId}/{threadId}`, and `buildReportSessionUrl` spells the full URL. The TypeScript side and the Go side stay locked by the shared test vectors, which this change adds under `src/__tests__/fixtures/` as byte-identical copies of the storage backend's `kernel/contenttoken/testdata` files: `preview-res.json` and `report-session-res.json`.
- A session-page publisher seam, shaped like `PreviewPublisher`: `SessionPagePublisher.mintSessionPageAccess(analysisId, threadId)`, with `UnavailableSessionPagePublisher` as the local default.
- The access arm returns to `preview_report`. When the composition binds the publisher and the render lands, the `rendered` arm carries the URL beside the path. A refused mint rides the arm as data, and it never fails the render. Unbound, the result is exactly what it was.
- The eyes URL becomes seam-resolved. `examine_page` gains an optional `resolvePageUrl` dep, and absent it navigates through a `file://` URL as today. Thus a managed browser with no workspace mount looks at the served page.
- The two seams thread through `createReportSessionAgent` and `assembleCoreRuntime`, thus an embedder binds them at its composition root.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-session-agent`: the capability gains the URL space of a session page, the publisher seam, and the access arm of the preview tool.
- `report-verification`: the eyes-tool requirement gains the seam-resolved URL, with the `file://` navigation as the default.

## Impact

- Affected code: `src/contracts/content-url.ts`, `src/tools/report-session/{session-page-publisher,preview-report,examine-page}.ts`, `src/agents/report-session-agent.ts`, `src/runtime/assemble.ts`, `src/index.ts`, and their tests.
- Every new dep is optional, thus the CLI path and every existing embedder compile and behave as before.
- The storage backend mirrors the formula in Go, and the Caddy predicate gains the new space. Both land in their own repositories against the same test vector.
