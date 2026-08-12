/**
 * LocalRunAuthorizer — the OSS realization of the `RunAuthorizer` seam.
 *
 * Issues a durable `RunSession` straight from the async-edge input: no remote
 * authorization, no credential read. It owns nothing revocable (it mints no
 * jti), so `revoke` and `revokeByJti` are no-ops. The opaque caller `auth` is
 * forwarded untouched — local code never
 * inspects it (no `getAuth`).
 */

import type { RunSession } from "./types.js";
import type { AuthorizeRunInput, RunAuthorization, RunAuthorizer } from "../execution/run-authorizer.js";

export function createLocalRunAuthorizer(): RunAuthorizer {
    return {
        async authorize({ auth, scope, provenance, frame }: AuthorizeRunInput): Promise<RunAuthorization> {
            const runSession: RunSession = {
                identity: { user: "local" },
                scope,
                provenance,
                runFrame: frame,
                auth,
            };
            return { runSession, ownsMandate: false }; // oss-core-managed-ok
        },
        async revoke() {},
        async revokeByJti() {},
    };
}
