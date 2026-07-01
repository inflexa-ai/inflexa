import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import { describeAuthError, isExpiring, tokenWireToStoredAuth, type AuthError, type StoredAuth } from "./auth.ts";
import { decodeIdTokenClaims } from "./whoami.ts";

/** A JWT whose payload segment encodes `payloadJson`; header + signature are placeholders. */
function jwtWithPayload(payloadJson: string): string {
    return `header.${Buffer.from(payloadJson).toString("base64url")}.signature`;
}

function storedAuth(overrides: Partial<StoredAuth> = {}): StoredAuth {
    return {
        accessToken: "access",
        refreshToken: "refresh",
        idToken: "id",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        ...overrides,
    };
}

describe("describeAuthError", () => {
    const errors: AuthError[] = [
        { type: "missing_config", missingVars: ["INFLEXA_AUTH0_DOMAIN"] },
        { type: "not_authenticated" },
        { type: "device_code_request_failed", detail: "boom" },
        { type: "token_poll_failed", detail: "nope" },
        { type: "authorization_expired" },
        { type: "authorization_denied" },
        { type: "refresh_failed", detail: "stale" },
        { type: "revoke_failed", detail: "denied" },
        { type: "token_read_failed", cause: new Error("read failed") },
        { type: "token_write_failed", cause: new Error("write failed") },
    ];

    test("returns a non-empty message for every variant", () => {
        for (const error of errors) {
            expect(describeAuthError(error).length).toBeGreaterThan(0);
        }
    });

    test("interpolates the variant's own detail into the message", () => {
        expect(describeAuthError({ type: "missing_config", missingVars: ["INFLEXA_AUTH0_DOMAIN"] })).toContain("INFLEXA_AUTH0_DOMAIN");
        expect(describeAuthError({ type: "device_code_request_failed", detail: "boom" })).toContain("boom");
        expect(describeAuthError({ type: "token_read_failed", cause: new Error("read failed") })).toContain("read failed");
    });
});

describe("decodeIdTokenClaims", () => {
    test("decodes the displayed claims from the payload segment", () => {
        const token = jwtWithPayload(JSON.stringify({ sub: "auth0|1", email: "a@b.com", name: "Ann" }));
        expect(decodeIdTokenClaims(token)).toEqual({ sub: "auth0|1", email: "a@b.com", name: "Ann" });
    });

    test("strips unknown claims, keeping only sub/email/name", () => {
        const token = jwtWithPayload(JSON.stringify({ email: "a@b.com", role: "admin" }));
        expect(decodeIdTokenClaims(token)).toEqual({ email: "a@b.com" });
    });

    test("returns null when there is no payload segment", () => {
        expect(decodeIdTokenClaims("no-dots-here")).toBeNull();
    });

    test("returns null when the payload is not valid JSON", () => {
        expect(decodeIdTokenClaims(jwtWithPayload("{not json"))).toBeNull();
    });

    test("returns null when the payload is not an object", () => {
        expect(decodeIdTokenClaims(jwtWithPayload(JSON.stringify("just-a-string")))).toBeNull();
    });
});

describe("isExpiring", () => {
    test("false when the access token has well over the safety buffer left", () => {
        expect(isExpiring(storedAuth({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() }))).toBe(false);
    });

    test("true when within the 60s buffer", () => {
        expect(isExpiring(storedAuth({ expiresAt: new Date(Date.now() + 30_000).toISOString() }))).toBe(true);
    });

    test("true when already expired", () => {
        expect(isExpiring(storedAuth({ expiresAt: new Date(Date.now() - 1_000).toISOString() }))).toBe(true);
    });
});

describe("tokenWireToStoredAuth", () => {
    test("builds the stored shape from a complete first-login response", () => {
        const before = Date.now();
        const stored = tokenWireToStoredAuth({ access_token: "AT", refresh_token: "RT", id_token: "IT", expires_in: 3600 }, null)._unsafeUnwrap();
        const after = Date.now();
        expect(stored.accessToken).toBe("AT");
        expect(stored.refreshToken).toBe("RT");
        expect(stored.idToken).toBe("IT");
        const expiresMs = new Date(stored.expiresAt).getTime();
        expect(expiresMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
        expect(expiresMs).toBeLessThanOrEqual(after + 3600 * 1000);
    });

    test("fills the rotated refresh token and id_token from the previous auth when the refresh response omits them", () => {
        const previous = storedAuth({ refreshToken: "OLD_RT", idToken: "OLD_IT" });
        const stored = tokenWireToStoredAuth({ access_token: "NEW_AT", expires_in: 3600 }, previous)._unsafeUnwrap();
        expect(stored.accessToken).toBe("NEW_AT");
        expect(stored.refreshToken).toBe("OLD_RT");
        expect(stored.idToken).toBe("OLD_IT");
    });

    test("errors when a required field (access_token) is missing", () => {
        tokenWireToStoredAuth({ refresh_token: "RT", id_token: "IT", expires_in: 3600 }, null).match(
            () => {
                throw new Error("expected an error for the missing access_token");
            },
            (msg) => expect(msg).toContain("missing required fields"),
        );
    });

    test("errors when no refresh token is available from the response or the previous auth", () => {
        tokenWireToStoredAuth({ access_token: "AT", id_token: "IT", expires_in: 3600 }, null).match(
            () => {
                throw new Error("expected an error for the missing refresh token");
            },
            (msg) => expect(msg).toContain("no refresh token"),
        );
    });
});
