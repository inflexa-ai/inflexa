import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import { getLogger } from "../../lib/log.ts";

/**
 * Where a secret of the user lives: a value keyed by an account, for example the URL of an MCP endpoint or the name of
 * a credential. On macOS the Keychain holds it, and a `0600` file is the fallback when the Keychain refuses a write,
 * for example a locked Keychain in an SSH session. On Linux and Windows the file holds it.
 */
export type SecretStore = {
    readonly read: (account: string) => Promise<string | undefined>;
    readonly write: (account: string, value: string) => Promise<void>;
    readonly remove: (account: string) => Promise<void>;
};

/** The effectful edges of the store, injectable for tests: the Keychain commands and the file. */
export type SecretStoreOpts = {
    /** The Keychain service of the secrets of one kind. */
    readonly service: string;
    readonly filePath: string;
    readonly platform?: NodeJS.Platform;
    /** Run `security` with the arguments and the standard input. Gives the exit code and the standard output. */
    readonly security?: (args: readonly string[], stdin?: string) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
};

const SecretFileSchema = z.record(z.string(), z.string());

async function runSecurity(args: readonly string[], stdin?: string): Promise<{ readonly exitCode: number; readonly stdout: string }> {
    const proc = Bun.spawn({ cmd: ["security", ...args], stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "ignore" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, stdout };
}

/**
 * True for an account that can go into a line of `security -i`: no quote, no backslash, and no white space. The
 * interactive mode reads each line as a command, thus such a character could add a command. The secret of another
 * account stays in the file.
 */
function keychainSafe(account: string): boolean {
    if (account.length === 0) return false;
    for (const char of account) if (char === '"' || char === "\\" || char.trim() === "") return false;
    return true;
}

function withoutKey<T>(entries: Readonly<Record<string, T>>, key: string): Record<string, T> {
    return Object.fromEntries(Object.entries(entries).filter(([candidate]) => candidate !== key));
}

export function createSecretStore(opts: SecretStoreOpts): SecretStore {
    const platform = opts.platform ?? process.platform;
    const security = opts.security ?? runSecurity;
    const log = getLogger("secret-store");

    const readFile = (): Record<string, string> => {
        if (!existsSync(opts.filePath)) return {};
        try {
            const entries = JSON.parseWith(readFileSync(opts.filePath, "utf8"), SecretFileSchema);
            if (entries !== null) return entries;
        } catch {
            // A file that cannot be read is moved aside below, the same as a file that does not parse.
        }
        // The next write replaces the file, thus the secrets that it holds go to a copy that the user can restore.
        const kept = `${opts.filePath}.unreadable-${Date.now()}`;
        try {
            renameSync(opts.filePath, kept);
            log.warn({ kept }, "the secret file cannot be read; it moved aside");
        } catch {
            // A different caller moved the file first.
        }
        return {};
    };
    const writeFile = (entries: Record<string, string>): void => {
        mkdirSync(dirname(opts.filePath), { recursive: true });
        const tmp = `${opts.filePath}.${randomUUID()}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
        renameSync(tmp, opts.filePath);
    };

    const keychainRead = async (account: string): Promise<string | undefined> => {
        if (!keychainSafe(account)) return undefined;
        const found = await security(["find-generic-password", "-s", opts.service, "-a", account, "-w"]);
        if (found.exitCode !== 0) return undefined;
        // `-w` prints a printable value as it is, then a newline. Each secret here is printable text: a token, a key,
        // or the JSON of a sign-in.
        return found.stdout.endsWith("\n") ? found.stdout.slice(0, -1) : found.stdout;
    };
    // The value goes in as hexadecimal on the standard input of `security -i`, thus no secret is on a command line that
    // another process can read.
    const keychainWrite = async (account: string, value: string): Promise<boolean> => {
        if (!keychainSafe(account)) return false;
        const hex = Buffer.from(value, "utf8").toString("hex");
        const done = await security(["-i"], `add-generic-password -U -s ${opts.service} -a "${account}" -X ${hex}\n`);
        return done.exitCode === 0 && (await keychainRead(account)) === value;
    };

    return {
        read: async (account) => {
            if (platform === "darwin") {
                const fromKeychain = await keychainRead(account);
                if (fromKeychain !== undefined) return fromKeychain;
            }
            return readFile()[account];
        },
        write: async (account, value) => {
            if (platform === "darwin" && (await keychainWrite(account, value))) {
                const entries = readFile();
                if (account in entries) writeFile(withoutKey(entries, account));
                return;
            }
            if (platform === "darwin") log.warn({ service: opts.service }, "the Keychain refused a secret; it goes to the 0600 file");
            writeFile({ ...readFile(), [account]: value });
        },
        remove: async (account) => {
            if (platform === "darwin" && keychainSafe(account)) await security(["delete-generic-password", "-s", opts.service, "-a", account]);
            const entries = readFile();
            if (account in entries) writeFile(withoutKey(entries, account));
        },
    };
}
