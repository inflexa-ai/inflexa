import { afterEach, describe, expect, it } from "bun:test";
import type { OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";

import { createInMemoryCatalog } from "../../catalog/memory.js";
import { resolveCatalog } from "../../catalog/resolve.js";
import { makeToolContext } from "../../tools/__fixtures__/tool-context.js";
import { createMcpConnections, type McpConnections } from "../connections.js";
import { startMcpOAuthFixture, type McpOAuthFixture } from "../oauth-fixture.js";
import { revokeMcpSignIn, signInToMcpServer, type McpAuthorizationCallback } from "../oauth.js";

/** A provider over memory. Its browser is a `fetch` that follows the redirects of the authorization page. */
function memoryProvider(redirectUrl: string, onCallback: (url: URL) => void): OAuthClientProvider & { stored: () => StoredOAuthTokens | undefined } {
    let client: StoredOAuthClientInformation | undefined;
    let tokens: StoredOAuthTokens | undefined;
    let verifier = "";
    return {
        redirectUrl,
        clientMetadata: {
            client_name: "test",
            redirect_uris: [redirectUrl],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
        },
        clientInformation: () => client,
        saveClientInformation: (info) => {
            client = info;
        },
        tokens: () => tokens,
        saveTokens: (saved) => {
            tokens = saved;
        },
        redirectToAuthorization: async (url) => {
            const page = await fetch(url, { redirect: "manual" });
            onCallback(new URL(page.headers.get("location") ?? ""));
        },
        saveCodeVerifier: (saved) => {
            verifier = saved;
        },
        codeVerifier: () => verifier,
        stored: () => tokens,
    };
}

let fixture: McpOAuthFixture | undefined;
let connections: McpConnections | undefined;
afterEach(async () => {
    await connections?.close();
    await fixture?.close();
    connections = undefined;
    fixture = undefined;
});

async function signedIn(server: McpOAuthFixture) {
    let deliver: (callback: McpAuthorizationCallback) => void = () => undefined;
    const callback = new Promise<McpAuthorizationCallback>((resolve) => {
        deliver = resolve;
    });
    const provider = memoryProvider("http://127.0.0.1:1/callback", (url) => deliver({ code: url.searchParams.get("code") ?? "" }));
    const result = await signInToMcpServer({ url: server.url, provider, waitForCallback: () => callback });
    return { provider, result };
}

describe("the OAuth sign-in of an MCP server", () => {
    it("registers, signs in with PKCE, and the next tool call carries the access token", async () => {
        fixture = await startMcpOAuthFixture();
        const { provider, result } = await signedIn(fixture);
        expect(result).toEqual({ status: "authorized" });
        expect(provider.stored()?.access_token).toBe("access-1");

        connections = createMcpConnections();
        const catalog = createInMemoryCatalog({
            mcpServers: [{ name: "remote", transport: { kind: "http", url: fixture.url, headers: {}, auth: provider }, approval: "never", scriptable: false }],
        });
        const tools = await connections.toolsFor(["remote"], await resolveCatalog(catalog));
        const whoami = tools.direct.find((tool) => tool.id === "mcp__remote__whoami");
        const output = await whoami?.execute({}, makeToolContext().ctx);

        expect(output?._unsafeUnwrap()).toMatchObject({ text: "access-1" });
        expect(fixture.bearerTokens.filter((token) => token !== null).every((token) => token === "access-1")).toBe(true);
    });

    it("revokes the refresh token, then the access token, and the server refuses the access token after", async () => {
        fixture = await startMcpOAuthFixture();
        const { provider } = await signedIn(fixture);

        expect(await revokeMcpSignIn({ url: fixture.url, provider })).toEqual({ status: "revoked" });
        expect(fixture.revoked).toEqual(["refresh-1", "access-1"]);
        const after = await fetch(fixture.url, { method: "POST", headers: { authorization: "Bearer access-1" }, body: "{}" });
        expect(after.status).toBe(401);
    });

    it("sends no request to a server with no revocation endpoint, and a provider with no tokens has nothing to revoke", async () => {
        fixture = await startMcpOAuthFixture({ revocation: false });
        const { provider } = await signedIn(fixture);

        expect(await revokeMcpSignIn({ url: fixture.url, provider })).toEqual({ status: "no_endpoint" });
        expect(fixture.revoked).toEqual([]);
        expect(await revokeMcpSignIn({ url: fixture.url, provider: memoryProvider("http://127.0.0.1:1/callback", () => undefined) })).toEqual({
            status: "not_signed_in",
        });
    });
});
