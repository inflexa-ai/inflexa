import type { RunAuthorizer } from "@inflexa-ai/harness";

/** Stands for a member that the code under test must not reach: the call fails the test with the name of the member. */
export function refuse(member: string): never {
    throw new Error(`${member} is not reached by this test`);
}

/** A {@link RunAuthorizer} that refuses each call, for a test of code that stores the authorizer and never calls it. */
export const refusingRunAuthorizer: RunAuthorizer = {
    authorize: () => refuse("runAuthorizer.authorize"),
    revoke: () => refuse("runAuthorizer.revoke"),
    revokeByMandateId: () => refuse("runAuthorizer.revokeByMandateId"),
    suspend: () => refuse("runAuthorizer.suspend"),
    renew: () => refuse("runAuthorizer.renew"),
};
