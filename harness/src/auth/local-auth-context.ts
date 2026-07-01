/**
 * OSS realization of the opaque `AuthContext`.
 *
 * The harness carries `AuthContext` through every session but never inspects it (see
 * `auth/types.ts`). The managed build backs it with a concrete
 * credential + org (`makeManagedAuth` in `auth-context.ts`); the OSS build
 * supplies this trivial value instead — it carries no credential and no org,
 * and no adapter ever downcasts it. Local code forwards `auth` untouched and
 * MUST NOT call `getAuth` (which would downcast this empty value to a managed
 * credential that isn't there).
 */

import type { AuthContext } from "./types.js";

/**
 * Build the trivial opaque `auth` value an OSS session constructor stores.
 * Returned as `AuthContext` so callers stay credential-blind. The cast bridges
 * the empty literal to the phantom-branded interface; the brand is an optional
 * `never`, so no real field is fabricated.
 */
export function makeLocalAuth(): AuthContext {
    return {} as AuthContext;
}
