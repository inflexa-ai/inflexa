/**
 * SessionPagePublisher — the seam between the report-session path and the hosted view of its page.
 *
 * The preview tool writes the page under the session directory and gives back the path. A local host
 * opens the file, thus it needs no seam. A managed host serves the page over HTTP, and the one thing
 * that reaches outside the process is the mint of a content-token grant for the URL space
 * `report-sessions/{analysisId}/{threadId}` (`contracts/content-url.ts`). That mint hides behind this
 * one method.
 *
 * The managed realization owns the grant mint and its client. A mint runs under the credential of the
 * tool call, thus the composition binds a factory and the preview tool builds the publisher over the
 * scope of the call — exactly as it builds the reference resolver. A boot-time singleton could not
 * carry that credential, and a host that bans ambient state could not bind one at all. The local
 * default (`UnavailableSessionPagePublisher`) returns not-ok, thus the preview tool attaches no URL
 * and the render still lands — the page path stays the whole local contract.
 */

import type { AuthContext } from "../../auth/types.js";

export type SessionPageMintResult =
    { ok: true; data: { baseUrl: string; token: string; expiresAt: string } } | { ok: false; status?: number; error: { message?: string } };

/** The not-ok arm of the seam's result — what a failed mint is allowed to carry. */
export type SessionPageMintFailure = Extract<SessionPageMintResult, { ok: false }>;

/**
 * Renders a failed mint as the line an agent reads back from the preview tool.
 *
 * The failure shape is sparse by design: a realization with no HTTP transport behind it supplies
 * neither a status nor, necessarily, a message. Naming a field the seam left unset would put the
 * literal `status=undefined` in front of the model, thus the line carries only what actually arrived.
 * It lives beside the type because its whole job is to honour that type's optionality.
 */
export function describeSessionPageMintFailure(failure: SessionPageMintFailure): string {
    const detail: string[] = [];
    if (failure.status !== undefined) detail.push(`status=${failure.status}`);
    const message = failure.error.message?.trim();
    if (message) detail.push(message);
    return detail.length > 0 ? `session-page-access mint failed: ${detail.join(" ")}` : "session-page-access mint failed";
}

export interface SessionPagePublisher {
    /**
     * Mint the access grant of one session page. The publisher binds the analysis, thus the mint takes
     * the thread id alone. `baseUrl` is the base URL of the content server, with no res path — the
     * caller spells the whole URL through `buildReportSessionUrl`, thus the formula lives in the
     * contract and never in a realization.
     */
    mintSessionPageAccess(threadId: string): Promise<SessionPageMintResult>;
}

/**
 * The per-call construction of the publisher. The factory binds one analysis and the auth of the tool
 * call, thus a realization mints under the credential of the caller and holds no ambient state.
 */
export type MakeSessionPagePublisher = (scope: { analysisId: string; auth: AuthContext }) => SessionPagePublisher;

/**
 * Local default — no hosted view of a session page. Returns not-ok, thus the preview tool carries the
 * refusal as data and the page path stays the whole result.
 */
export class UnavailableSessionPagePublisher implements SessionPagePublisher {
    async mintSessionPageAccess(_threadId: string): Promise<SessionPageMintResult> {
        return {
            ok: false,
            error: { message: "the hosted view of a session page is unavailable in this environment" },
        };
    }
}
