/**
 * The tool-approval seam contract: the request a conversation tool pauses on,
 * the decision the user returns, and the deny-by-default realization shipped for
 * hosts that wire no interactive surface.
 *
 * The seam is generic — nothing here names a tool or a domain. A tool describes
 * the concrete action it needs approved (`AskRequest`); a surface renders it, the
 * user decides, and the decision comes back as an `AskApproval` on approval or an
 * `AskRejectedError` throw on denial.
 *
 * These are standalone types so `define-tool.ts` can type-import them into
 * `ToolContext` without an import cycle back through the tools layer.
 */

/**
 * The human-facing content a surface renders to describe the exact action being
 * approved. `command` is the concrete operation the user sees and approves — what
 * they saw is precisely what is granted, nothing broader. No tool- or
 * domain-specific fields: the harness stays agnostic to what is being approved.
 */
export interface AskRequest {
    readonly title: string;
    readonly command: string;
    readonly detail?: string;
    /**
     * Keys the standing grant an `always` records when the class being blessed is
     * broader than the displayed `command` — a tool that grants a whole family of
     * operations passes the family's key here while still showing one concrete
     * command. It is a generic, opaque key string, not a tool- or domain-specific
     * field, and the surface never renders it. Absent, the grant keys on `command`.
     */
    readonly grantKey?: string;
}

/**
 * A user's decision on an approval request — three distinct outcomes, never a
 * boolean. `once` approves the single pending invocation; `always` approves it
 * AND records a standing grant for the matched action; `reject` denies and MAY
 * carry model-facing feedback.
 *
 * This full three-variant union is the wire type the outward `answer` API takes;
 * `ctx.ask` itself resolves only with the `AskApproval` subset (denial throws).
 */
export type AskReply = { readonly kind: "once" } | { readonly kind: "always" } | { readonly kind: "reject"; readonly feedback?: string };

/**
 * The subset of `AskReply` `ctx.ask` may resolve with. Denial never returns — it
 * throws `AskRejectedError` — so a resolved approval is only ever `once` or
 * `always`, and a caller never has to inspect for a reject variant.
 */
export type AskApproval = Exclude<AskReply, { kind: "reject" }>;

/**
 * The throw a `reject` reply raises out of `ctx.ask`, carrying the optional
 * model-facing feedback.
 *
 * Denial is a throw rather than a returned reject variant so a tool never has to
 * inspect the reply to learn it was denied: only asks throw, so the throw itself
 * is the denial signal, and the loop needs no per-tool "was denied" flag — it maps
 * the caught error to an execution-denied tool result and stops the turn.
 */
export class AskRejectedError extends Error {
    readonly feedback?: string;

    constructor(feedback?: string) {
        super(feedback ? `approval rejected: ${feedback}` : "approval rejected");
        this.name = "AskRejectedError";
        this.feedback = feedback;
    }
}

/**
 * The user-approval seam. `ask` pauses on an approval request and resolves with
 * the approval decision, or throws `AskRejectedError` when the user denies.
 * Realizations are wired by the embedder; an unwired host resolves to
 * `UnavailableAsk`.
 */
export interface Ask {
    ask(request: AskRequest): Promise<AskApproval>;
}

/**
 * Deny-by-default realization — the shipped `Ask` for hosts that wire no
 * interactive surface (workflow contexts, headless embedders). Every request is
 * denied, so a tool that calls `ctx.ask` where nothing can answer is rejected
 * rather than left waiting on a surface that will never respond.
 */
export class UnavailableAsk implements Ask {
    async ask(_request: AskRequest): Promise<AskApproval> {
        throw new AskRejectedError("approval is unavailable in this environment");
    }
}
