/**
 * A local MCP server that needs an OAuth sign-in, for a test of a host. One HTTP server is the protected resource at
 * `/mcp` and its authorization server: discovery, dynamic client registration, the authorization page with PKCE, the
 * token endpoint, and the revocation endpoint. The authorization page grants each request at once and redirects to the
 * callback of the host, thus a test opens the page with a plain `fetch` that follows redirects.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { z } from "zod";

import { parseJsonAs, safeParseJsonAs } from "../lib/parse-json.js";
import { errorMessageOf } from "../lib/thrown.js";

export type McpOAuthFixture = {
    /** The URL of the MCP endpoint, which a host config names. */
    readonly url: string;
    /** The access token of each MCP request, in order. `null` for a request with no bearer token. */
    readonly bearerTokens: readonly (string | null)[];
    /** Each token that the revocation endpoint received, in order. */
    readonly revoked: readonly string[];
    readonly close: () => Promise<void>;
};

export type McpOAuthFixtureOpts = {
    /** False: the metadata names no revocation endpoint. Default true. */
    readonly revocation?: boolean;
};

type Grant = { readonly challenge: string; readonly redirectUri: string };

const JsonRpcMessageSchema = z.object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.looseObject({ protocolVersion: z.string().optional() }).optional(),
});

const ClientMetadataSchema = z.looseObject({});

async function bodyOf(request: IncomingMessage): Promise<string> {
    let text = "";
    request.setEncoding("utf8");
    for await (const chunk of request) text += String(chunk);
    return text;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

function sha256Base64Url(text: string): string {
    return createHash("sha256").update(text).digest("base64url");
}

/** The JSON-RPC answer of the MCP endpoint: one tool, `whoami`, that gives the access token of the call. */
function mcpAnswer(message: z.infer<typeof JsonRpcMessageSchema>, token: string): unknown {
    switch (message.method) {
        case "initialize":
            return { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "oauth-fixture", version: "1.0.0" } };
        case "tools/list":
            return { tools: [{ name: "whoami", description: "Give the access token of the call.", inputSchema: { type: "object", properties: {} } }] };
        case "tools/call":
            return { content: [{ type: "text", text: token }] };
        default:
            return undefined;
    }
}

export async function startMcpOAuthFixture(opts: McpOAuthFixtureOpts = {}): Promise<McpOAuthFixture> {
    const bearerTokens: (string | null)[] = [];
    const revoked: string[] = [];
    const grants = new Map<string, Grant>();
    const active = new Set<string>();
    let issued = 0;
    let base = "";

    const server = createServer((request, response) => {
        void handle(request, response).catch((failure: unknown) =>
            sendJson(response, 500, { error: "server_error", error_description: errorMessageOf(failure) ?? "the fixture failed" }),
        );
    });

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? "/", base);
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
            sendJson(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
            return;
        }
        if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
            const metadata: Record<string, unknown> = {
                issuer: base,
                authorization_endpoint: `${base}/authorize`,
                token_endpoint: `${base}/token`,
                registration_endpoint: `${base}/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
            };
            if (opts.revocation !== false) metadata.revocation_endpoint = `${base}/revoke`;
            sendJson(response, 200, metadata);
            return;
        }
        if (url.pathname === "/register" && request.method === "POST") {
            const metadata = parseJsonAs(await bodyOf(request), ClientMetadataSchema);
            sendJson(response, 201, { ...metadata, client_id: "fixture-client" });
            return;
        }
        if (url.pathname === "/authorize") {
            const redirectUri = url.searchParams.get("redirect_uri") ?? "";
            const code = `code-${grants.size + 1}`;
            grants.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirectUri });
            const target = new URL(redirectUri);
            target.searchParams.set("code", code);
            const state = url.searchParams.get("state");
            if (state !== null) target.searchParams.set("state", state);
            response.writeHead(302, { location: target.toString() });
            response.end();
            return;
        }
        if (url.pathname === "/token" && request.method === "POST") {
            const form = new URLSearchParams(await bodyOf(request));
            const grant = grants.get(form.get("code") ?? "");
            const verified =
                grant !== undefined && sha256Base64Url(form.get("code_verifier") ?? "") === grant.challenge && form.get("redirect_uri") === grant.redirectUri;
            if (form.get("grant_type") !== "authorization_code" || !verified) {
                sendJson(response, 400, { error: "invalid_grant" });
                return;
            }
            issued += 1;
            const accessToken = `access-${issued}`;
            active.add(accessToken);
            sendJson(response, 200, { access_token: accessToken, token_type: "Bearer", refresh_token: `refresh-${issued}`, expires_in: 3600 });
            return;
        }
        if (url.pathname === "/revoke" && request.method === "POST") {
            const token = new URLSearchParams(await bodyOf(request)).get("token") ?? "";
            revoked.push(token);
            active.delete(token);
            response.writeHead(200);
            response.end();
            return;
        }
        if (url.pathname === "/mcp") {
            const header = request.headers.authorization;
            const token = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : null;
            bearerTokens.push(token);
            if (token === null || !active.has(token)) {
                response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
                response.end();
                return;
            }
            if (request.method !== "POST") {
                response.writeHead(405);
                response.end();
                return;
            }
            const parsed = safeParseJsonAs(await bodyOf(request), JsonRpcMessageSchema);
            const message = parsed.success ? parsed.data : undefined;
            if (message?.id === undefined) {
                response.writeHead(202);
                response.end();
                return;
            }
            const result = mcpAnswer(message, token);
            sendJson(
                response,
                200,
                result === undefined
                    ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
                    : { jsonrpc: "2.0", id: message.id, result },
            );
            return;
        }
        response.writeHead(404);
        response.end();
    }

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a local address");
    base = `http://127.0.0.1:${address.port}`;

    return {
        url: `${base}/mcp`,
        bearerTokens,
        revoked,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
