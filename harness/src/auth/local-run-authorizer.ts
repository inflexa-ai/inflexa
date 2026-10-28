/**
 * LocalRunAuthorizer — the OSS realization of the `RunAuthorizer` seam.
 *
 * Issues a durable `RunSession` straight from the async-edge input: no remote
 * authorization, no credential read. It owns nothing revocable (it mints no
 * reference), so `revoke`, `revokeByMandateId`, `suspend`, and `renew` are no-ops. The opaque caller `auth` is
 * forwarded untouched — local code never
 * inspects it (no `getAuth`).
 */

import { okAsync } from "neverthrow";

import type { RunSession } from "./types.js";
import type { AuthorizeRunInput, RunAuthorizer } from "../execution/run-authorizer.js";

export function createLocalRunAuthorizer(): RunAuthorizer {
    return {
        authorize({ auth, scope, provenance, frame }: AuthorizeRunInput) {
            const runSession: RunSession = {
                identity: { user: "local" },
                scope,
                provenance,
                runFrame: frame,
                auth,
            };
            return okAsync(runSession);
        },
        revoke: () => okAsync(undefined),
        revokeByMandateId: () => okAsync(undefined), // oss-core-managed-ok
        suspend: () => okAsync(undefined),
        renew: () => okAsync(undefined),
    };
}
