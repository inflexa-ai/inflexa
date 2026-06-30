/**
 * RunAuthorizer — the async-edge run-authorization seam.
 *
 * Every async edge that starts durable work (`execute_plan`, `run_ephemeral`,
 * data-profile) must turn the caller's opaque auth into a durable `RunSession`
 * before dispatching a workflow. That turning is the ONE place the credential
 * kind matters (a live caller credential → mint a fresh run credential Cortex
 * owns; an existing run credential → reuse it, caller-owned) — so it lives
 * behind this seam, not in the harness tools. The managed impl owns the
 * mint/reuse + revoke against the host authority; an OSS impl issues a local
 * `RunSession` with no host call, no jti, no revoke. The harness's tools depend only on
 * this interface and never read a credential.
 *
 * Mirrors the `PreviewPublisher` seam: a narrow interface in the harness, the managed
 * realization injected at the composition root.
 */

import type { AuthContext, Provenance, RunFrame, RunSession, Scope } from "../auth/types.js";

/** What an async edge knows when it authorizes a run: the opaque caller auth,
 * the scope + provenance to stamp on the run, and the run frame to mint for. */
export interface AuthorizeRunInput {
    readonly auth: AuthContext;
    readonly scope: Scope;
    readonly provenance: Provenance;
    readonly frame: RunFrame;
}

export interface RunAuthorization {
    readonly runSession: RunSession;
    /**
     * True when this authorizer minted the run credential and therefore owns its
     * lifecycle — the run's terminal path must `revoke`. False when an existing
     * run credential was reused (the caller owns it; `revoke` is a no-op).
     */
    readonly ownsMandate: boolean; // oss-core-managed-ok
}

/**
 * Authorize durable work at the async edge. `authorize` produces the durable
 * `RunSession`; `revoke` releases a self-minted run credential on the terminal
 * path (a no-op for reused or local authorizations).
 */
export interface RunAuthorizer {
    authorize(input: AuthorizeRunInput): Promise<RunAuthorization>;
    revoke(authorization: RunAuthorization, reason: string): Promise<void>;
}
