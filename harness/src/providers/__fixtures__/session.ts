/**
 * Test-only harness `RequestSession` builder. Not a `*.test.ts` file, so the test
 * runner ignores it; imported by harness unit tests that need a session but never
 * read its (opaque) auth. `auth` defaults to the trivial local value the harness
 * never inspects; an embedder whose adapters downcast `auth` to a concrete type
 * overrides it rather than re-declaring the whole session shape.
 */

import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { AuthContext, RequestSession, Scope } from "../../auth/types.js";

export interface SessionOverrides {
    user?: string;
    scope?: Scope;
    agentId?: string;
    callPath?: readonly string[];
    auth?: AuthContext;
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
        auth: overrides.auth ?? makeLocalAuth(),
    };
}
