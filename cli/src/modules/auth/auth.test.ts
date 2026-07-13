import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import {
    audienceInvalidReason,
    describeAuthError,
    isExpiring,
    resolveAuth0ConfigFrom,
    tokenWireToStoredAuth,
    type AuthError,
    type StoredAuth,
} from "./auth.ts";
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
        { type: "invalid_audience", variable: "INFLEXA_AUTH0_AUDIENCE", reason: "not_a_uri", valuePrefix: "abcdefghijkl…" },
        { type: "invalid_audience", variable: "INFLEXA_AUTH0_AUDIENCE", reason: "management_api", valuePrefix: "https://dev-…" },
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

    test("points a non-URI audience back at the pasted value", () => {
        const message = describeAuthError({ type: "invalid_audience", variable: "INFLEXA_AUTH0_AUDIENCE", reason: "not_a_uri", valuePrefix: "abcdefghijkl…" });
        expect(message).toContain("INFLEXA_AUTH0_AUDIENCE");
        expect(message).toContain("abcdefghijkl…");
    });

    test("explains why the Management API cannot be the audience", () => {
        const message = describeAuthError({
            type: "invalid_audience",
            variable: "INFLEXA_AUTH0_AUDIENCE",
            reason: "management_api",
            valuePrefix: "https://dev-…",
        });
        expect(message).toContain("Management API");
        expect(message.toLowerCase()).toContain("refresh token");
    });
});

describe("audienceInvalidReason", () => {
    // Scheme-less base64url text (no `:`, so not a URI). Fabricated, not a credential from the repo.
    const schemeless = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

    test("accepts the product API identifier for any domain", () => {
        expect(audienceInvalidReason("https://api.inflexa.ai", "dev-tenant.us.auth0.com")).toBeNull();
    });

    test("accepts a non-https URN scheme", () => {
        expect(audienceInvalidReason("urn:inflexa:api", "dev-tenant.us.auth0.com")).toBeNull();
    });

    test("rejects a scheme-less blob as not_a_uri", () => {
        expect(audienceInvalidReason(schemeless, "dev-tenant.us.auth0.com")).toBe("not_a_uri");
    });

    test("rejects the Auth0 Management API for the configured domain", () => {
        expect(audienceInvalidReason("https://dev-tenant.us.auth0.com/api/v2/", "dev-tenant.us.auth0.com")).toBe("management_api");
    });

    test("accepts a third-party API whose path merely contains /api/v2/ on another host", () => {
        expect(audienceInvalidReason("https://other-host.example.com/api/v2/", "dev-tenant.us.auth0.com")).toBeNull();
    });
});

describe("resolveAuth0ConfigFrom", () => {
    test("reports missing vars before checking audience validity", () => {
        const error = resolveAuth0ConfigFrom(undefined, "client", undefined)._unsafeUnwrapErr();
        expect(error).toEqual({ type: "missing_config", missingVars: ["INFLEXA_AUTH0_DOMAIN", "INFLEXA_AUTH0_AUDIENCE"] });
    });

    test("rejects a present-but-invalid audience without leaking the full value", () => {
        // A scheme-less secret in the audience slot: exactly the paste this guard exists to catch.
        const secret = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
        const error = resolveAuth0ConfigFrom("dev-tenant.us.auth0.com", "client", secret)._unsafeUnwrapErr();
        if (error.type !== "invalid_audience") throw new Error(`expected invalid_audience, got ${error.type}`);
        expect(error.reason).toBe("not_a_uri");
        expect(error.variable).toBe("INFLEXA_AUTH0_AUDIENCE");
        expect(error.valuePrefix).toBe(secret.slice(0, 12) + "…");
        // The full secret must never survive into the error object or its rendered message.
        expect(error.valuePrefix).not.toContain(secret);
        expect(describeAuthError(error)).not.toContain(secret);
    });

    test("resolves the config when all three values are present and the audience is valid", () => {
        const config = resolveAuth0ConfigFrom("dev-tenant.us.auth0.com", "client", "https://api.inflexa.ai")._unsafeUnwrap();
        expect(config).toEqual({ domain: "dev-tenant.us.auth0.com", clientId: "client", audience: "https://api.inflexa.ai" });
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
