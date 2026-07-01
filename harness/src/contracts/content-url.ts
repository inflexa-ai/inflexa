/**
 * Content URL construction — shared between the frontend and Cortex.
 *
 * The `res` claim formula and URL shape are the canonical TypeScript contract
 * for the content-token preview flow. The storage backend mirrors the formula in Go; both
 * sides are locked by the shared test vector at
 * `src/__tests__/fixtures/preview-res.json`.
 *
 * End-to-end contract:
 *   token res claim : "previews/{analysisId}/{previewId}"
 *   URL             : {contentBaseUrl}/previews/{analysisId}/{previewId}/{previewPath}?t={token}
 *   Filesystem path : /sessions/previews/{analysisId}/{previewId}/{previewPath}
 *   Caddy predicate : request.path.startsWith("/" + res + "/")
 *
 * The harness's contracts module owns this TS implementation so both the harness and
 * react-client consume one canonical formula.
 */

/**
 * Canonical `res` claim formula for a preview. Returns the literal string
 * `previews/{analysisId}/{previewId}` with no leading or trailing slash.
 *
 * This is also the filesystem sub-path under `/sessions/` on the session PVC
 * and the URL sub-path served by the content-server (Caddy).
 *
 * MUST match `fmt.Sprintf("previews/%s/%s", analysisID, previewID)` in
 * the storage backend's Go preview-access implementation. Drift is caught by the shared test
 * vector at `src/__tests__/fixtures/preview-res.json`.
 */
export function previewResourceId(analysisId: string, previewId: string): string {
    return `previews/${analysisId}/${previewId}`;
}

/**
 * Build a content-token preview URL for an iframe src.
 *
 * Produces `{contentBaseUrl}/{res}/{previewPath}?t={token}` where `res` is
 * the output of `previewResourceId(analysisId, previewId)`. The query parameter
 * name is `t` (matching Caddy's `from_query t` directive). The token is
 * URL-encoded.
 *
 * @param contentBaseUrl - Content server base URL (trailing slash tolerated)
 * @param analysisId - The analysis ID (authorization boundary)
 * @param previewId - The preview ID (groups all versions)
 * @param previewPath - Version-relative path (e.g., "v1/index.html"). Leading slash tolerated.
 * @param token - Short-lived content token minted by the storage backend (required)
 */
export function buildPreviewUrl(contentBaseUrl: string, analysisId: string, previewId: string, previewPath: string, token: string): string {
    const base = contentBaseUrl.replace(/\/+$/, "");
    const path = previewPath.replace(/^\/+/, "");
    const res = previewResourceId(analysisId, previewId);
    return `${base}/${res}/${path}?t=${encodeURIComponent(token)}`;
}
