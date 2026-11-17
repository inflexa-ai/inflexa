import type { McpOAuthClientInformation, McpOAuthClientMetadata, McpOAuthDiscoveryState, McpOAuthProvider, McpOAuthTokens } from "@inflexa-ai/harness";
import { z } from "zod";

import { env } from "../../lib/env.ts";
import { createSecretStore, type SecretStoreOpts } from "./secret_store.ts";

/** The sign-in state of one MCP endpoint: the client registration, the tokens, and the code verifier of a flow in progress. */
export type McpTokenEntry = {
    readonly redirectUrl?: string;
    readonly clientInformation?: McpOAuthClientInformation;
    readonly tokens?: McpOAuthTokens;
    readonly codeVerifier?: string;
};

/**
 * Where the sign-in state of each MCP endpoint lives. On macOS the Keychain holds it, and a `0600` file is the
 * fallback when the Keychain refuses a write, for example a locked Keychain in an SSH session. On Linux and Windows
 * the file holds it. Each entry is keyed by the URL of the endpoint, thus a copy of a config entry under a new name
 * still reaches the same sign-in, and a different URL needs its own sign-in.
 */
export type McpTokenStore = {
    readonly read: (endpoint: string) => Promise<McpTokenEntry | undefined>;
    readonly write: (endpoint: string, entry: McpTokenEntry) => Promise<void>;
    readonly remove: (endpoint: string) => Promise<void>;
};

/** The stored tokens: an access token and its type, plus the fields that the OAuth server adds. */
const TokensSchema = z.custom<McpOAuthTokens>((value) => z.looseObject({ access_token: z.string(), token_type: z.string() }).safeParse(value).success);

/** The stored registration: a client id, plus the fields that the OAuth server adds. */
const ClientInformationSchema = z.custom<McpOAuthClientInformation>((value) => z.looseObject({ client_id: z.string() }).safeParse(value).success);

/** The JSON form of an entry. */
const McpTokenEntrySchema = z.object({
    redirectUrl: z.string().optional(),
    clientInformation: ClientInformationSchema.optional(),
    tokens: TokensSchema.optional(),
    codeVerifier: z.string().optional(),
});

/** The Keychain service of the MCP sign-ins. */
const KEYCHAIN_SERVICE = "inflexa-mcp";

/** The secret store of the MCP sign-ins, injectable for tests. */
export type McpTokenStoreOpts = Partial<Omit<SecretStoreOpts, "service">>;

/** The sign-in state of each MCP endpoint as JSON in a {@link SecretStore}, keyed by the URL of the endpoint. */
export function createMcpTokenStore(opts: McpTokenStoreOpts = {}): McpTokenStore {
    const secrets = createSecretStore({ ...opts, service: KEYCHAIN_SERVICE, filePath: opts.filePath ?? env.mcpTokensPath });
    return {
        read: async (endpoint) => {
            const text = await secrets.read(endpoint);
            if (text === undefined) return undefined;
            return JSON.parseWith(text, McpTokenEntrySchema) ?? undefined;
        },
        write: (endpoint, entry) => secrets.write(endpoint, JSON.stringify(entry)),
        remove: (endpoint) => secrets.remove(endpoint),
    };
}

/** What a provider of one server needs: the store, and for an interactive sign-in, the callback URL and the browser. */
export type McpOAuthProviderOpts = {
    readonly server: string;
    readonly url: string;
    readonly store: McpTokenStore;
    /** The loopback callback of an interactive sign-in. Absent: the provider only reads and refreshes stored tokens. */
    readonly redirectUrl?: string;
    /** Open the authorization page. Absent: a call that needs a new sign-in fails, and the user runs `inflexa mcp auth`. */
    readonly openBrowser?: (url: URL) => void;
};

/** The redirect URL of a provider that cannot sign in. The server never sees it, because a refresh needs no redirect. */
const NON_INTERACTIVE_REDIRECT = "http://127.0.0.1/inflexa-mcp-callback";

/**
 * The OAuth client of one MCP server over the token store. A provider for a tool call reads and refreshes the stored
 * tokens. A provider for `inflexa mcp auth` also registers the client with its loopback callback and opens the
 * browser.
 */
export function createMcpOAuthProvider(opts: McpOAuthProviderOpts): McpOAuthProvider {
    const redirectUrl = opts.redirectUrl ?? NON_INTERACTIVE_REDIRECT;
    let codeVerifier: string | undefined;
    let discoveryState: McpOAuthDiscoveryState | undefined;
    const update = async (change: Partial<McpTokenEntry>): Promise<void> => {
        const current = (await opts.store.read(opts.url)) ?? {};
        await opts.store.write(opts.url, { ...current, ...change });
    };
    const metadata: McpOAuthClientMetadata = {
        client_name: "Inflexa",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
    };
    return {
        get redirectUrl() {
            return redirectUrl;
        },
        get clientMetadata() {
            return metadata;
        },
        clientInformation: async () => {
            const entry = await opts.store.read(opts.url);
            // A registration names its redirect URL. An interactive sign-in on a new loopback port registers again.
            if (opts.redirectUrl !== undefined && entry?.redirectUrl !== opts.redirectUrl) return undefined;
            return entry?.clientInformation;
        },
        saveClientInformation: (clientInformation) => update({ clientInformation, redirectUrl }),
        tokens: async () => (await opts.store.read(opts.url))?.tokens,
        saveTokens: (tokens) => update({ tokens }),
        redirectToAuthorization: (authorizationUrl) => {
            opts.openBrowser?.(authorizationUrl);
        },
        saveCodeVerifier: (verifier) => {
            codeVerifier = verifier;
        },
        // The SDK asks for the verifier only after it saved one in the same flow. An empty verifier makes the token
        // exchange fail at the authorization server, which the sign-in then reports.
        codeVerifier: () => codeVerifier ?? "",
        // The SDK binds the callback to the authorization server that started the flow (SEP-2352). One sign-in runs in
        // one process, thus the state lives beside the verifier.
        saveDiscoveryState: (state) => {
            discoveryState = state;
        },
        discoveryState: () => discoveryState,
    };
}
