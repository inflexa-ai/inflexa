import { readFile } from "node:fs/promises";

import { type Result, ok, err } from "neverthrow";
import { z } from "zod";
import { ensureRuntime } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { PROXY_CONTAINER_NAME } from "./compose.ts";
import { managementKeyPath } from "./proxy_config.ts";

// A failed chat call through CLIProxyAPI says too little to act on: a dead login and a provider rate
// limit can both arrive as a 429 or an `auth_unavailable`. The proxy's management API reports the state
// of each credential, so this module asks it. The launch gate and the TUI both read the verdict.
//
// The API answers only a request from inside the container (`allow-remote: false`, see
// proxy_config.ts), so the read runs through `docker exec`. The image has no curl or wget, so bash
// `/dev/tcp` makes the request. The key goes through the exec environment, never the command line, so
// it does not show in the host process list.

/** Bounds the whole exec round trip, so a wedged engine or proxy never stalls the launch or the TUI. */
const READ_TIMEOUT_MS = 5_000;

/**
 * What the proxy says about its provider credentials:
 * - `login_dead` — each usable credential failed a refresh or got a 401, so only a new login fixes it.
 * - `rate_limited` — the provider refused a request with a quota error, and the proxy retries at
 *   `retryAt` (the earliest one when more than one credential waits).
 * - `unknown` — no credential, or nothing in the state explains the failure.
 */
export type CredentialVerdict = { kind: "login_dead" } | { kind: "rate_limited"; retryAt: Date } | { kind: "unknown" };

/** Why the management API could not answer. Each case keeps the caller on its old path. */
export type CredentialStateError =
    { type: "no_key" } | { type: "no_runtime"; message: string } | { type: "exec_failed"; detail: string } | { type: "bad_response"; detail: string };

/**
 * The status messages that CLIProxyAPI v7.3.17 writes when a credential cannot recover without a login:
 * a refresh that got a 401 (`unauthorized`), a Claude refresh that got `invalid_grant` on a 400 and left
 * an expired token (`token expired`), and the request-side `invalid_grant`. The `payment_required` state
 * is left out, because a new login does not fix an account that the provider refuses to bill.
 */
const DEAD_LOGIN_MESSAGES: ReadonlySet<string> = new Set(["unauthorized", "invalid_grant", "token expired"]);
const DEAD_LOGIN_REASONS: ReadonlySet<string> = new Set(["unauthorized", "invalid_grant"]);
const QUOTA_REASONS: ReadonlySet<string> = new Set(["quota", "credential_quota"]);

const authFilesSchema = z.object({
    files: z.array(
        z.object({
            disabled: z.boolean().optional(),
            status: z.string().optional(),
            status_message: z.string().optional(),
            cooldowns: z.array(z.object({ reason: z.string().optional(), retry_at: z.string().optional() })).optional(),
        }),
    ),
});

/** One credential entry of `/v0/management/auth-files`, as {@link classifyCredentials} reads it. */
export type AuthFileEntry = z.infer<typeof authFilesSchema>["files"][number];

/**
 * Reduce the proxy's credential entries to one verdict. A dead login wins only when EVERY usable
 * credential is dead, because the proxy still serves from a live one. Exported for its unit tests.
 */
export function classifyCredentials(files: readonly AuthFileEntry[]): CredentialVerdict {
    const usable = files.filter((f) => f.disabled !== true);
    if (usable.length === 0) return { kind: "unknown" };
    const dead = usable.every(
        (f) =>
            (f.status === "error" && DEAD_LOGIN_MESSAGES.has(f.status_message ?? "")) ||
            (f.cooldowns ?? []).some((c) => DEAD_LOGIN_REASONS.has(c.reason ?? "")),
    );
    if (dead) return { kind: "login_dead" };
    const retryTimes = usable
        .flatMap((f) => f.cooldowns ?? [])
        .filter((c) => QUOTA_REASONS.has(c.reason ?? "") && c.retry_at !== undefined)
        .map((c) => new Date(c.retry_at ?? ""))
        .filter((d) => !Number.isNaN(d.getTime()));
    if (retryTimes.length > 0) return { kind: "rate_limited", retryAt: new Date(Math.min(...retryTimes.map((d) => d.getTime()))) };
    return { kind: "unknown" };
}

/** Read the credential state from the running proxy and classify it. */
export async function readCredentialVerdict(): Promise<Result<CredentialVerdict, CredentialStateError>> {
    const key = await readFile(managementKeyPath(), "utf8").then(
        (text) => text.trim(),
        () => "",
    );
    if (key === "") return err({ type: "no_key" });
    const rt = await ensureRuntime();
    if (rt.isErr()) return err({ type: "no_runtime", message: rt.error.message });

    // HTTP/1.0 so the proxy closes the connection after the body and `cat` ends. The body follows the
    // first blank line; the proxy sends no chunked encoding to a 1.0 client.
    const script =
        `exec 3<>/dev/tcp/127.0.0.1/${env.cliproxyPort} && ` +
        `printf 'GET /v0/management/auth-files HTTP/1.0\\r\\nHost: localhost\\r\\nAuthorization: Bearer %s\\r\\n\\r\\n' "$CPA_MANAGEMENT_KEY" >&3 && ` +
        `cat <&3`;
    let stdout: string;
    let code: number | null;
    try {
        const proc = Bun.spawn({
            cmd: [rt.value.bin, "exec", "-e", "CPA_MANAGEMENT_KEY", PROXY_CONTAINER_NAME, "bash", "-c", script],
            /* eslint-disable no-restricted-properties -- the docker client wants the parent's PATH, HOME and
               DOCKER_* to reach the engine. The key goes on the child's env object only, so it stays off the
               host's `ps` listing and out of this process's env. This is a child env write, not a config read. */
            env: { ...process.env, CPA_MANAGEMENT_KEY: key },
            /* eslint-enable no-restricted-properties */
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
            timeout: READ_TIMEOUT_MS,
        });
        stdout = await new Response(proc.stdout).text();
        code = await proc.exited;
    } catch (cause) {
        return err({ type: "exec_failed", detail: cause instanceof Error ? cause.message : String(cause) });
    }
    if (code !== 0) return err({ type: "exec_failed", detail: `exit code ${code}` });

    const split = stdout.indexOf("\r\n\r\n");
    const statusLine = stdout.slice(0, stdout.indexOf("\r\n"));
    if (split < 0 || !/^HTTP\/1\.[01] 200 /.test(statusLine)) return err({ type: "bad_response", detail: statusLine || "no response" });
    const body = JSON.parseWith(stdout.slice(split + 4), authFilesSchema);
    if (body === null) return err({ type: "bad_response", detail: "unexpected auth-files body" });
    return ok(classifyCredentials(body.files));
}
