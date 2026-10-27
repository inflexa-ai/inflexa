/**
 * The tool-approval contract: the request that the approval hook of a tool gives,
 * and the decision that the user returns.
 *
 * The contract is generic — nothing here names a tool or a domain. A tool describes
 * the concrete action it needs approved (`AskRequest`); a surface renders it, the
 * user decides, and the loop runs the call on an approval or denies it.
 *
 * These are standalone types so `define-tool.ts` can type-import them without an
 * import cycle back through the tools layer.
 */

/**
 * The human-facing content a surface renders to describe the exact action being
 * approved. `command` is the concrete operation the user sees and approves — what
 * they saw is precisely what is granted, nothing broader. No tool- or
 * domain-specific fields: the harness stays agnostic to what is being approved.
 */
export type AskRequest = {
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
};

/**
 * A user's decision on an approval request — three distinct outcomes, never a
 * boolean. `once` approves the single pending invocation; `always` approves it
 * AND records a standing grant for the matched action; `reject` denies and MAY
 * carry model-facing feedback.
 */
export type AskReply = { readonly kind: "once" } | { readonly kind: "always" } | { readonly kind: "reject"; readonly feedback?: string };
