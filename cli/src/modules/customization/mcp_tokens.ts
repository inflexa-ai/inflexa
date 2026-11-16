import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { McpOAuthClientInformation, McpOAuthClientMetadata, McpOAuthDiscoveryState, McpOAuthProvider, McpOAuthTokens } from "@inflexa-ai/harness";
import { z } from "zod";

import { env } from "../../lib/env.ts";
import { getLogger } from "../../lib/log.ts";

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

const TokenFileSchema = z.record(z.string(), McpTokenEntrySchema);

const KEYCHAIN_SERVICE = "inflexa-mcp";

/** The effectful edges of the store, injectable for tests: the Keychain commands and the file. */
export type McpTokenStoreOpts = {
    readonly platform?: NodeJS.Platform;
    readonly filePath?: string;
    /** Run `security` with the arguments and the standard input. Gives the exit code and the standard output. */
    readonly security?: (args: readonly string[], stdin?: string) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
};

async function runSecurity(args: readonly string[], stdin?: string): Promise<{ readonly exitCode: number; readonly stdout: string }> {
    const proc = Bun.spawn({ cmd: ["security", ...args], stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "ignore" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
}

/**
 * True for an endpoint that can go into a line of `security -i`: a URL in its normal form, with no quote, no backslash,
 * and no white space. The interactive mode reads each line as a command, thus such a character could add a command.
 * The endpoint of another form keeps its sign-in in the token file.
 */
function keychainSafe(endpoint: string): boolean {
    if (!URL.canParse(endpoint) || new URL(endpoint).href !== endpoint) return false;
    for (const char of endpoint) if (char === '"' || char === "\\" || char.trim() === "") return false;
    return true;
}

function parseEntry(text: string): McpTokenEntry | undefined {
    let parsed: z.infer<typeof McpTokenEntrySchema> | null;
    try {
        parsed = JSON.parseWith(text, McpTokenEntrySchema);
    } catch {
        return undefined;
    }
    return parsed ?? undefined;
}

export function createMcpTokenStore(opts: McpTokenStoreOpts = {}): McpTokenStore {
    const platform = opts.platform ?? process.platform;
    const filePath = opts.filePath ?? env.mcpTokensPath;
    const security = opts.security ?? runSecurity;
    const log = getLogger("mcp-tokens");

    const readFile = (): Record<string, z.infer<typeof McpTokenEntrySchema>> => {
        try {
            return JSON.parseWith(readFileSync(filePath, "utf8"), TokenFileSchema) ?? {};
        } catch {
            return {};
        }
    };
    const writeFile = (entries: Record<string, unknown>): void => {
        mkdirSync(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, filePath);
    };

    const keychainRead = async (endpoint: string): Promise<McpTokenEntry | undefined> => {
        if (!keychainSafe(endpoint)) return undefined;
        const found = await security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", endpoint, "-w"]);
        return found.exitCode === 0 ? parseEntry(found.stdout.trim()) : undefined;
    };
    // The value goes in as hexadecimal on the standard input of `security -i`, thus no token is on a command line
    // that another process can read.
    const keychainWrite = async (endpoint: string, entry: McpTokenEntry): Promise<boolean> => {
        if (!keychainSafe(endpoint)) return false;
        const hex = Buffer.from(JSON.stringify(entry), "utf8").toString("hex");
        const done = await security(["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${endpoint}" -X ${hex}\n`);
        return done.exitCode === 0 && (await keychainRead(endpoint)) !== undefined;
    };

    return {
        read: async (endpoint) => {
            if (platform === "darwin") {
                const fromKeychain = await keychainRead(endpoint);
                if (fromKeychain !== undefined) return fromKeychain;
            }
            const stored = readFile()[endpoint];
            return stored === undefined ? undefined : parseEntry(JSON.stringify(stored));
        },
        write: async (endpoint, entry) => {
            if (platform === "darwin" && (await keychainWrite(endpoint, entry))) {
                const entries = readFile();
                if (endpoint in entries) writeFile(withoutKey(entries, endpoint));
                return;
            }
            if (platform === "darwin") log.warn({ endpoint }, "the Keychain refused the sign-in of an MCP server; it goes to the token file");
            writeFile({ ...readFile(), [endpoint]: entry });
        },
        remove: async (endpoint) => {
            if (platform === "darwin" && keychainSafe(endpoint)) await security(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", endpoint]);
            const entries = readFile();
            if (endpoint in entries) writeFile(withoutKey(entries, endpoint));
        },
    };
}

function withoutKey<T>(entries: Readonly<Record<string, T>>, key: string): Record<string, T> {
    return Object.fromEntries(Object.entries(entries).filter(([candidate]) => candidate !== key));
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
