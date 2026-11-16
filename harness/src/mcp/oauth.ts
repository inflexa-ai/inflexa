/**
 * The sign-in of an MCP server over OAuth. The host owns the browser, the callback, and the storage of the tokens.
 * The harness runs the protocol, thus a host needs no MCP library of its own.
 */

import { auth, discoverOAuthServerInfo, type OAuthClientProvider } from "@modelcontextprotocol/client";

import { z } from "zod";

import { errorMessageOf } from "../lib/thrown.js";

export type {
    OAuthDiscoveryState as McpOAuthDiscoveryState,
    OAuthClientInformationContext as McpOAuthContext,
    OAuthClientMetadata as McpOAuthClientMetadata,
    OAuthClientProvider as McpOAuthProvider,
    StoredOAuthClientInformation as McpOAuthClientInformation,
    StoredOAuthTokens as McpOAuthTokens,
} from "@modelcontextprotocol/client";

/** What the browser gives back on the callback of the host. */
export type McpAuthorizationCallback = {
    readonly code: string;
    /** The `iss` parameter of the callback, when the authorization server sends one. */
    readonly iss?: string;
};

export type McpSignInResult = { readonly status: "authorized" } | { readonly status: "failed"; readonly reason: string };

/**
 * Sign in to an MCP server. The first call refreshes a stored token when it can. Else it sends the user to the
 * authorization page through `provider.redirectToAuthorization`, waits for the callback of the host, and exchanges the
 * code for tokens, which the provider stores.
 */
export async function signInToMcpServer(input: {
    readonly url: string;
    readonly provider: OAuthClientProvider;
    readonly waitForCallback: () => Promise<McpAuthorizationCallback>;
}): Promise<McpSignInResult> {
    try {
        const first = await auth(input.provider, { serverUrl: input.url });
        if (first === "AUTHORIZED") return { status: "authorized" };
        const callback = await input.waitForCallback();
        const second = await auth(input.provider, { serverUrl: input.url, authorizationCode: callback.code, iss: callback.iss });
        return second === "AUTHORIZED" ? { status: "authorized" } : { status: "failed", reason: "the authorization server asked for a second redirect" };
    } catch (failure) {
        return { status: "failed", reason: errorMessageOf(failure) ?? "the sign-in failed" };
    }
}

/** The one field of the authorization server metadata that a revocation reads. */
const RevocationMetadataSchema = z.looseObject({ revocation_endpoint: z.string().optional() });

export type McpRevokeResult =
    | { readonly status: "revoked" }
    | { readonly status: "not_signed_in" }
    | { readonly status: "no_endpoint" }
    | { readonly status: "failed"; readonly reason: string };

/**
 * Revoke the stored tokens of an MCP server at its authorization server (RFC 7009): the refresh token first, because
 * a server can revoke the access tokens of a grant with it, then the access token. The SDK finds the endpoint, and it
 * gives no revocation call of its own. A server that publishes no revocation endpoint gets no request, and its tokens
 * expire on their own. The host deletes the stored tokens in each case.
 */
export async function revokeMcpSignIn(input: { readonly url: string; readonly provider: OAuthClientProvider }): Promise<McpRevokeResult> {
    try {
        const tokens = await input.provider.tokens();
        if (tokens === undefined) return { status: "not_signed_in" };
        const metadata = RevocationMetadataSchema.safeParse((await discoverOAuthServerInfo(input.url)).authorizationServerMetadata);
        const endpoint = metadata.success ? metadata.data.revocation_endpoint : undefined;
        if (endpoint === undefined) return { status: "no_endpoint" };
        const client = await input.provider.clientInformation();
        const candidates = [
            { token: tokens.refresh_token, hint: "refresh_token" },
            { token: tokens.access_token, hint: "access_token" },
        ];
        for (const { token, hint } of candidates) {
            if (token === undefined) continue;
            const body = new URLSearchParams({ token, token_type_hint: hint });
            if (client !== undefined) body.set("client_id", client.client_id);
            if (client?.client_secret !== undefined) body.set("client_secret", client.client_secret);
            const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
            if (!response.ok) return { status: "failed", reason: `the revocation endpoint answered ${response.status}` };
        }
        return { status: "revoked" };
    } catch (failure) {
        return { status: "failed", reason: errorMessageOf(failure) ?? "the revocation failed" };
    }
}
