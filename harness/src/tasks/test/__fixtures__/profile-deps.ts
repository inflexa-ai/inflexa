/**
 * The deps fragments of the pause-path suites: the run authorizer never authorizes, and it records every
 * revoke reason, so a test can name the revocations that it expects.
 */

import { join } from "node:path";
import { okAsync } from "neverthrow";

import { createWorkspaceFilesystem } from "../../../workspace/filesystem.js";
import type { DataProfileDeps } from "../../data-profile.js";

/** The never-authorizing run authorizer, with the revoke recorder of the suite. */
export function runAuthorizerOf(revoked: string[]): DataProfileDeps["runAuthorizer"] {
    return {
        authorize: () => {
            throw new Error("the body never authorizes");
        },
        revoke: (_runSession, reason) => {
            revoked.push(reason);
            return okAsync(undefined);
        },
        revokeByMandateId: () => okAsync(undefined),
        suspend: () => okAsync(undefined),
        renew: () => okAsync(undefined),
    };
}

/** The workspace filesystem and root resolver over one temp root. */
export function workspaceOf(root: string): Pick<DataProfileDeps, "workspaceFs" | "resolveWorkspaceRoot"> {
    return {
        workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => Promise.resolve(join(root, id)) }),
        resolveWorkspaceRoot: (id) => Promise.resolve(join(root, id)),
    };
}
