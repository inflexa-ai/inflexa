# Delta: report-session-agent

## ADDED Requirements

### Requirement: The URL space of a session page
The `res` claim formula of a session page MUST be `report-sessions/{analysisId}/{threadId}`, with no leading slash and no trailing slash (`reportSessionResourceId` in `contracts/content-url.ts`). The URL of a served page MUST be `{contentBaseUrl}/report-sessions/{analysisId}/{threadId}/{pagePath}?t={token}`, with the token URL-encoded (`buildReportSessionUrl`). The TypeScript formulas and the Go mirrors of the storage backend MUST stay locked by the shared test vectors at `src/__tests__/fixtures/preview-res.json` and `src/__tests__/fixtures/report-session-res.json`, each a byte-identical copy of the storage backend's `kernel/contenttoken/testdata` file.

The claim carries the analysis id, because the URL needs an authorization boundary. On disk the page sits at `report-sessions/{threadId}/` under the workspace root, thus a host that serves the space owns the map between the two.

#### Scenario: The formula matches the shared vector
- **WHEN** the TypeScript formula runs over each report-session vector of the shared fixture
- **THEN** each result equals the recorded res of that vector

#### Scenario: The URL spells the res space
- **WHEN** `buildReportSessionUrl` composes a URL over a base, an analysis, a thread, a page path, and a token
- **THEN** the URL is the base, the res, and the page path, with the encoded token under the `t` query parameter

### Requirement: The session-page publisher seam
The composition MUST give the hosted view of a session page through one publisher seam. The mint operation takes the analysis id and the thread id, and it returns the grant or the typed refusal. A grant carries the base URL of the content server, the token, and the expiry — the caller spells the whole URL through `buildReportSessionUrl`, thus the formula lives in the contract and never in a realization. The local default MUST return the not-ok arm, thus a composition with no hosted surface stays on the page path.

#### Scenario: The local default refuses
- **WHEN** the unavailable publisher mints
- **THEN** the result is not-ok, and the message names the unavailable hosted view

## MODIFIED Requirements

### Requirement: The render-and-preview tool

When the composition binds the session-page publisher, the tool MUST mint one grant after the page lands, and the `rendered` arm MUST carry the URL of the space `report-sessions/{analysisId}/{threadId}` beside the page path. A refused mint MUST ride the arm as data, and it MUST NOT fail the render. An unbound publisher MUST change nothing: the arm carries the path alone.

#### Scenario: The URL rides beside the path
- **WHEN** the render passes and the bound publisher grants
- **THEN** the `rendered` arm carries the page path and the URL of the session page

#### Scenario: A refused mint keeps the render
- **WHEN** the render passes and the bound publisher refuses
- **THEN** the `rendered` arm carries the page path, the refusal as data, and the page is on disk
