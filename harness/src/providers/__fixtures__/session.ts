/**
 * Test-only harness `RequestSession` builder. Not a `*.test.ts` file, so the test
 * runner ignores it; imported by harness unit tests that need a session but never
 * read its (opaque) auth. The auth is the trivial local one — the harness never
 * inspects it. Managed-adapter tests that exercise `getAuth` / the managed seams
 * use the managed builder in `compose/__fixtures__/session.ts` instead.
 */

import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { RequestSession, Scope } from "../../auth/types.js";

export interface SessionOverrides {
    user?: string;
    scope?: Scope;
    agentId?: string;
    callPath?: readonly string[];
}

/** Build a fully-populated harness `RequestSession` for tests, with per-field overrides. */
export function makeSession(overrides: SessionOverrides = {}): RequestSession {
    return {
        identity: { user: overrides.user ?? "user-001" },
        scope: overrides.scope ?? { kind: "analysis", analysisId: "analysis-001" },
        provenance: {
            agentId: overrides.agentId ?? "conversation-agent",
            callPath: overrides.callPath ?? ["conversation-agent"],
        },
        auth: makeLocalAuth(),
    };
}
