import { deleteAuth, describeAuthError, loadAuth, resolveAuth0Config, revokeRefreshToken, type StoredAuth } from "./auth.ts";

export async function logout(): Promise<void> {
    const loaded = loadAuth().match(
        (value): StoredAuth | "absent" | "unreadable" => value,
        (error) => (error.type === "not_authenticated" ? "absent" : "unreadable"),
    );
    if (loaded === "absent") {
        console.log("  No one is logged in.");
        return;
    }

    // Revocation is best-effort: kill the grant family at Auth0 when we can,
    // but never let a failure block the local logout. An unreadable token file
    // has nothing to revoke and is simply deleted below.
    if (loaded !== "unreadable") {
        const config = resolveAuth0Config().unwrapOr(null);
        if (config === null) {
            console.warn("  Warning: Auth0 configuration is not set; skipping server-side revocation.");
        } else {
            const revoked = await revokeRefreshToken(config, loaded.refreshToken);
            if (revoked.isErr()) {
                console.warn(`  Warning: ${describeAuthError(revoked.error)}`);
            }
        }
    }

    deleteAuth().match(
        () => console.log("  Logged out."),
        (error) => {
            console.error(`  ${describeAuthError(error)}`);
            process.exitCode = 1;
        },
    );
}
