/**
 * PreviewPublisher — the seam between the harness report path and the hosted
 * preview surface. The report build itself (FS + Nunjucks + LLM via
 * `ChatProvider`) is pure in-process; the only thing that reaches outside
 * the process is minting a content-server URL for the headless-Chrome
 * preview. That mint is hidden behind this one method.
 *
 * The managed implementation (HostedPreviewPublisher) owns the access
 * grant mint + managed client. The local default (UnavailablePreviewPublisher)
 * returns not-ok, so `preview_snapshot` short-circuits before touching
 * Chrome and the report still builds (submit_report is the only gate).
 */

export type PreviewMintResult =
    | { ok: true; data: { baseUrl: string; token: string; expiresAt: string } }
    | { ok: false; status?: number; error: { message?: string } };

export interface PreviewPublisher {
    mintPreviewAccess(resourceId: string, previewId: string): Promise<PreviewMintResult>;
}

/**
 * Local default — no hosted preview surface. Returns not-ok so the preview
 * tools surface a clear "unavailable" message and short-circuit before any
 * browser navigation.
 */
export class UnavailablePreviewPublisher implements PreviewPublisher {
    async mintPreviewAccess(_resourceId: string, _previewId: string): Promise<PreviewMintResult> {
        return {
            ok: false,
            error: { message: "report preview is unavailable in this environment" },
        };
    }
}
