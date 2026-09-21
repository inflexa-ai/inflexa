import { Buffer } from "node:buffer";

import { z } from "zod";

import { describeAuthError, loadAuth, type StoredAuth } from "./auth.ts";

/** Unknown claims are stripped by the schema; only the displayed ones matter. */
const idTokenClaimsSchema = z.object({
    sub: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
});
type IdTokenClaims = z.infer<typeof idTokenClaimsSchema>;

export function whoami(): void {
    loadAuth().match(printIdentity, (error) => {
        console.error(`  ${describeAuthError(error)}`);
        process.exitCode = 1;
    });
}

function printIdentity(auth: StoredAuth): void {
    console.log();
    const claims = decodeIdTokenClaims(auth.idToken);
    if (claims === null) {
        console.log("  Logged in, but the stored ID token could not be decoded.");
    } else {
        if (claims.name) console.log(`  Name:    ${claims.name}`);
        if (claims.email) console.log(`  Email:   ${claims.email}`);
        if (claims.sub) console.log(`  Subject: ${claims.sub}`);
    }

    const expiresAt = new Date(auth.expiresAt);
    const status =
        expiresAt.getTime() > Date.now() ? `active — access token expires ${expiresAt.toLocaleString()}` : "expired — renews automatically on next use";
    console.log(`  Session: ${status}`);
    console.log();
}

/**
 * The email of the signed-in identity, or `null` when the cli cannot name a person.
 *
 * The single answer to "who is the user" for the cli: the provenance recorder attributes a user
 * action to this value, and the chat turn engine stamps it as the author of a message. One rule
 * keeps a transcript and a provenance document on the same person.
 *
 * Absence rides the ok channel, because a signed-out cli is a normal condition and not a fault.
 * Every failure of the read collapses to `null`: no stored session, an unreadable file, a file that
 * the schema refuses, a token that does not decode, and a token with no email claim. An empty claim
 * is `null` too, because an empty name identifies nobody.
 */
export function currentUserEmail(): string | null {
    return loadAuth()
        .map((auth) => decodeIdTokenClaims(auth.idToken)?.email)
        .match(
            (email) => email || null,
            () => null,
        );
}

/**
 * Local decode only: the token came straight from Auth0 over TLS at login, so
 * whoami trusts it without signature verification (that is the API server's
 * job) and without any network round-trip.
 */
export function decodeIdTokenClaims(idToken: string): IdTokenClaims | null {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    try {
        const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); // unknown: JWT payload, validated by the schema below
        const result = idTokenClaimsSchema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}
