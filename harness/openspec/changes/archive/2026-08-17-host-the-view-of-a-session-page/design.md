# Design: host-the-view-of-a-session-page

## Context

The preview tool of a report session returns the page path alone (`src/tools/report-session/preview-report.ts`), and the eyes tool forms a `file://` URL at its one navigation (`src/tools/report-session/examine-page.ts`). The content-token contract (`src/contracts/content-url.ts`) names one space, `previews/{analysisId}/{previewId}`, and the review of PR #340 found that a minted URL for a session page named a space that the serving map cannot reach. The mint dropped there, and inflexa#342 is its home.

## Decisions

### D1: The formula mirrors the preview pair, and the vector locks both sides

`reportSessionResourceId` and `buildReportSessionUrl` sit beside the preview pair in the one contract module. The `res` claim is `report-sessions/{analysisId}/{threadId}`: the claim carries the analysis id because the URL needs an authorization boundary, and on disk the page sits at `report-sessions/{threadId}/` under the workspace root — the host owns the map. The Go mirror is `fmt.Sprintf("report-sessions/%s/%s", analysisID, threadID)` in the storage backend's `kernel/contenttoken`. The module doc always named a shared test vector, and no fixture existed in this repository. This change adds it, with the preview vectors of the storage-backend copy and the report-session vectors, thus both formulas are locked from now on.

### D2: The publisher gives the base, and the tool spells the URL

`SessionPagePublisher.mintSessionPageAccess(analysisId, threadId)` returns the same result arms as `PreviewPublisher`. Its `baseUrl` is the base URL of the content server, with no res path: the preview tool spells the whole URL through `buildReportSessionUrl`, thus the formula lives in the contract and a realization cannot drift from it. The seam lives beside the tools that hold it, in `src/tools/report-session/`, and it does not reuse the preview types — the two seams degrade independently, and a shared type would couple their wording.

### D3: A mint refusal is data on the `rendered` arm

The tool contract is ok-channel data for each degraded condition. The page landed, thus the arm stays `rendered` and carries `access: { granted: false; detail }`. A distinct outcome would read as a failed render, and an agent would run the preview again for a page that is on disk. A thrown realization takes the same arm, thus a broken grant surface never costs the render. An unbound publisher attaches no field at all, thus the local result is byte-identical to today.

### D4: The eyes URL is a seam with the `file://` default

`resolvePageUrl` takes the page path, the analysis id, and the thread id, and it gives the URL of one look. The default stays `pathToFileURL(pagePath).href` at the one call site, thus the CLI changes nothing. The seam replaces the URL and nothing else: the navigation, the readiness wait, the capture, and the seen stamp stay in the tool. A throw of the seam becomes the typed capture failure before any lease is acquired.

## Risks / Trade-offs

- The fixture lives in two repositories by hand, locked by code review. That is the standing discipline of the preview vector, and this change extends it rather than inventing a second mechanism.
- A served look depends on the grant lifetime of the storage backend. A stale URL reads as failed requests in the look result, and the agent runs the preview again — the same degradation as any capture fault.
