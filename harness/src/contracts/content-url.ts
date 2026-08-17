/**
 * Content URL construction — shared between the frontend and Cortex.
 *
 * The `res` claim formula and URL shape are the canonical TypeScript contract
 * for the content-token flow. The storage backend mirrors the formula in Go; both
 * sides are locked by the shared test vector at
 * `src/__tests__/fixtures/report-session-res.json` (report-session pages), a
 * byte-identical copy of the storage backend's `kernel/contenttoken/testdata` file.
 *
 * End-to-end contract (report-session pages):
 *   token res claim : "report-sessions/{analysisId}/{threadId}"  (token kind "rs")
 *   URL             : {contentBaseUrl}/report-sessions/{analysisId}/{threadId}/{pagePath}?t={token}
 *   Caddy predicate : request.path.startsWith("/" + res + "/")
 *
 * This is URL space only. On disk a session page lives inside its analysis's workspace tree, at
 * `{resolveWorkspaceRoot(analysisId)}/report-sessions/{threadId}/{pagePath}`
 * (the report-session-agent spec) — the `res` claim carries the analysis id because the URL needs an
 * authorization boundary, whereas the resolved root already identifies the analysis and so does not
 * repeat it. A host that serves the space owns the map between the two.
 *
 * The harness's contracts module owns this TS implementation so both the harness and
 * react-client consume one canonical formula.
 */

/**
 * Canonical `res` claim formula for a report-session page. Returns the literal string
 * `report-sessions/{analysisId}/{threadId}` with no leading or trailing slash.
 *
 * This is the URL sub-path served by the content-server (Caddy) and the token's
 * authorization boundary — NOT a filesystem sub-path; see the module doc.
 *
 * MUST match `fmt.Sprintf("report-sessions/%s/%s", analysisID, threadID)` in
 * the storage backend's Go `kernel/contenttoken` implementation. Drift is caught by the
 * shared test vector at `src/__tests__/fixtures/report-session-res.json`.
 */
export function reportSessionResourceId(analysisId: string, threadId: string): string {
    return `report-sessions/${analysisId}/${threadId}`;
}

/**
 * Build a content-token URL for a report-session page.
 *
 * Produces `{contentBaseUrl}/{res}/{pagePath}?t={token}` where `res` is
 * the output of `reportSessionResourceId(analysisId, threadId)`. The query parameter
 * name is `t` (matching Caddy's `from_query t` directive). The token is
 * URL-encoded.
 *
 * @param contentBaseUrl - Content server base URL (trailing slash tolerated)
 * @param analysisId - The analysis ID (authorization boundary)
 * @param threadId - The report thread ID (one session directory per thread)
 * @param pagePath - Session-relative path (typically "index.html"). Leading slash tolerated.
 * @param token - Short-lived content token minted by the storage backend (required)
 */
export function buildReportSessionUrl(contentBaseUrl: string, analysisId: string, threadId: string, pagePath: string, token: string): string {
    const base = contentBaseUrl.replace(/\/+$/, "");
    const path = pagePath.replace(/^\/+/, "");
    const res = reportSessionResourceId(analysisId, threadId);
    return `${base}/${res}/${path}?t=${encodeURIComponent(token)}`;
}
