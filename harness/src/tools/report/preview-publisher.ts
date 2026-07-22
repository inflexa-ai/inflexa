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
    { ok: true; data: { baseUrl: string; token: string; expiresAt: string } } | { ok: false; status?: number; error: { message?: string } };

/** The not-ok arm of the seam's result — what a failed mint is allowed to carry. */
export type PreviewMintFailure = Extract<PreviewMintResult, { ok: false }>;

/**
 * Renders a failed mint as the line an agent reads back from a preview tool.
 *
 * The failure shape is sparse by design: a realization with no HTTP transport
 * behind it supplies neither a status nor, necessarily, a message. Naming a
 * field the seam left unset would put the literal `status=undefined` in front
 * of the model, so the message carries only what actually arrived. This lives
 * beside the type because its whole job is to honour that type's optionality —
 * every tool holding the seam owes the same message, and one of them owning
 * the wording would make the others depend on a peer for a seam-wide concern.
 */
export function describeMintFailure(failure: PreviewMintFailure): string {
    const detail: string[] = [];
    if (failure.status !== undefined) detail.push(`status=${failure.status}`);
    const message = failure.error.message?.trim();
    if (message) detail.push(message);
    return detail.length > 0 ? `preview-access mint failed: ${detail.join(" ")}` : "preview-access mint failed";
}

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
