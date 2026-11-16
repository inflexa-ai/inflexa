import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { createMcpOAuthProvider, createMcpTokenStore, type McpTokenEntry, type McpTokenStore, type McpTokenStoreOpts } from "../mcp_tokens.ts";

const ENDPOINT = "https://lims.example/mcp";
const ENTRY: McpTokenEntry = { tokens: { access_token: "at-1", token_type: "Bearer" } };

type FakeSecurity = {
    readonly run: NonNullable<McpTokenStoreOpts["security"]>;
    readonly calls: { readonly args: readonly string[]; readonly stdin?: string }[];
    readonly items: Map<string, string>;
};

/**
 * A `security` stand-in over an in-memory Keychain, keyed by account. It reads the `-i` command line that the store
 * writes on the standard input. With `refuseWrites`, each write fails, as a locked Keychain does.
 */
function fakeSecurity(opts: { readonly refuseWrites?: boolean } = {}): FakeSecurity {
    const calls: FakeSecurity["calls"] = [];
    const items = new Map<string, string>();
    const accountOf = (args: readonly string[]): string => args[args.indexOf("-a") + 1] ?? "";
    const run: FakeSecurity["run"] = (args, stdin) => {
        calls.push({ args, stdin });
        if (args[0] === "-i") {
            if (opts.refuseWrites === true || stdin === undefined) return Promise.resolve({ exitCode: 1, stdout: "" });
            const words = stdin.trim().split(" ");
            const account = (words[words.indexOf("-a") + 1] ?? "").slice(1, -1);
            items.set(account, Buffer.from(words[words.indexOf("-X") + 1] ?? "", "hex").toString("utf8"));
            return Promise.resolve({ exitCode: 0, stdout: "" });
        }
        if (args[0] === "find-generic-password") {
            const value = items.get(accountOf(args));
            return Promise.resolve(value === undefined ? { exitCode: 44, stdout: "" } : { exitCode: 0, stdout: `${value}\n` });
        }
        if (args[0] === "delete-generic-password") return Promise.resolve({ exitCode: items.delete(accountOf(args)) ? 0 : 44, stdout: "" });
        return Promise.resolve({ exitCode: 1, stdout: "" });
    };
    return { run, calls, items };
}

let dir = "";
let filePath = "";
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "inflexa-mcp-tokens-"));
    filePath = join(dir, "data", "mcp-tokens.json");
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** The token file as the store writes it: the entries keyed by endpoint. */
const TokenFileSchema = z.record(z.string(), z.looseObject({ tokens: z.looseObject({ access_token: z.string(), token_type: z.string() }).optional() }));

function fileEntries(): Record<string, unknown> {
    return existsSync(filePath) ? (JSON.parseWith(readFileSync(filePath, "utf8"), TokenFileSchema) ?? {}) : {};
}

describe("createMcpTokenStore on macOS", () => {
    test("a write goes to the Keychain as hexadecimal on the standard input, and the file holds nothing", async () => {
        const security = fakeSecurity();
        const store = createMcpTokenStore({ platform: "darwin", filePath, security: security.run });

        await store.write(ENDPOINT, ENTRY);

        const write = security.calls.find((call) => call.args[0] === "-i");
        const hex = Buffer.from(JSON.stringify(ENTRY), "utf8").toString("hex");
        expect(write?.stdin).toBe(`add-generic-password -U -s inflexa-mcp -a "${ENDPOINT}" -X ${hex}\n`);
        expect(security.calls.flatMap((call) => call.args).join(" ")).not.toContain("at-1");
        expect(fileEntries()).toEqual({});
        expect(await store.read(ENDPOINT)).toEqual(ENTRY);
    });

    test("an endpoint with a quote never reaches `security`, and its entry goes to the file", async () => {
        const security = fakeSecurity();
        const store = createMcpTokenStore({ platform: "darwin", filePath, security: security.run });
        const endpoint = 'https://lims.example/mcp" -s other';

        await store.write(endpoint, ENTRY);

        expect(security.calls).toEqual([]);
        expect(fileEntries()).toEqual({ [endpoint]: ENTRY });
        expect(await store.read(endpoint)).toEqual(ENTRY);
        expect(security.calls).toEqual([]);
    });

    test("a write that the Keychain refuses goes to a 0600 file, and the next read finds it", async () => {
        const store = createMcpTokenStore({ platform: "darwin", filePath, security: fakeSecurity({ refuseWrites: true }).run });

        await store.write(ENDPOINT, ENTRY);

        expect(statSync(filePath).mode & 0o777).toBe(0o600);
        expect(fileEntries()).toEqual({ [ENDPOINT]: ENTRY });
        expect(await store.read(ENDPOINT)).toEqual(ENTRY);
    });

    test("a Keychain write removes an older entry of the same endpoint from the file", async () => {
        const security = fakeSecurity({ refuseWrites: true });
        await createMcpTokenStore({ platform: "darwin", filePath, security: security.run }).write(ENDPOINT, ENTRY);

        await createMcpTokenStore({ platform: "darwin", filePath, security: fakeSecurity().run }).write(ENDPOINT, ENTRY);

        expect(fileEntries()).toEqual({});
    });

    test("remove deletes the entry from the Keychain and from the file", async () => {
        const security = fakeSecurity();
        const store = createMcpTokenStore({ platform: "darwin", filePath, security: security.run });
        await store.write(ENDPOINT, ENTRY);
        await createMcpTokenStore({ platform: "darwin", filePath, security: fakeSecurity({ refuseWrites: true }).run }).write(
            "https://other.example/mcp",
            ENTRY,
        );
        await createMcpTokenStore({ platform: "darwin", filePath, security: fakeSecurity({ refuseWrites: true }).run }).write(ENDPOINT, ENTRY);

        await store.remove(ENDPOINT);

        expect(security.items.has(ENDPOINT)).toBe(false);
        expect(fileEntries()).toEqual({ "https://other.example/mcp": ENTRY });
        expect(await store.read(ENDPOINT)).toBeUndefined();
    });
});

describe("createMcpTokenStore on Linux", () => {
    test("the file holds each entry, and the store never runs `security`", async () => {
        const security = fakeSecurity();
        const store = createMcpTokenStore({ platform: "linux", filePath, security: security.run });

        await store.write(ENDPOINT, ENTRY);

        expect(security.calls).toEqual([]);
        expect(statSync(filePath).mode & 0o777).toBe(0o600);
        expect(await store.read(ENDPOINT)).toEqual(ENTRY);
        expect(await store.read("https://copy.example/mcp")).toBeUndefined();

        await store.remove(ENDPOINT);

        expect(await store.read(ENDPOINT)).toBeUndefined();
        expect(security.calls).toEqual([]);
    });
});

describe("createMcpOAuthProvider", () => {
    function linuxStore(): McpTokenStore {
        return createMcpTokenStore({ platform: "linux", filePath });
    }

    test("saved tokens read back, and the registration that a save keeps beside them stays", async () => {
        const store = linuxStore();
        const provider = createMcpOAuthProvider({ server: "lims", url: ENDPOINT, store });

        await provider.saveClientInformation?.({ client_id: "c-1" });
        await provider.saveTokens({ access_token: "at-2", token_type: "Bearer" });

        expect(await provider.tokens()).toEqual({ access_token: "at-2", token_type: "Bearer" });
        expect(await provider.clientInformation()).toEqual({ client_id: "c-1" });
    });

    test("an interactive sign-in on a new callback URL does not use the registration of an older callback URL", async () => {
        const store = linuxStore();
        const first = createMcpOAuthProvider({ server: "lims", url: ENDPOINT, store, redirectUrl: "http://127.0.0.1:4100/callback" });
        await first.saveClientInformation?.({ client_id: "c-1" });

        const same = createMcpOAuthProvider({ server: "lims", url: ENDPOINT, store, redirectUrl: "http://127.0.0.1:4100/callback" });
        const next = createMcpOAuthProvider({ server: "lims", url: ENDPOINT, store, redirectUrl: "http://127.0.0.1:4200/callback" });
        const nonInteractive = createMcpOAuthProvider({ server: "lims", url: ENDPOINT, store });

        expect(await same.clientInformation()).toEqual({ client_id: "c-1" });
        expect(await next.clientInformation()).toBeUndefined();
        expect(await nonInteractive.clientInformation()).toEqual({ client_id: "c-1" });
    });

    test("a provider of another URL reads no token of this URL", async () => {
        const store = linuxStore();
        await createMcpOAuthProvider({ server: "lims", url: ENDPOINT, store }).saveTokens({ access_token: "at-3", token_type: "Bearer" });

        expect(await createMcpOAuthProvider({ server: "lims-copy", url: "https://copy.example/mcp", store }).tokens()).toBeUndefined();
    });
});
