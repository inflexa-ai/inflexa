import { ok, err, type Result } from "neverthrow";
import { z } from "zod";
import type { ModelAuthConfig } from "./config.ts";
import { readEnvCredentialVar } from "./env.ts";

// A `direct` connection's wire credential, generalized from "a static key read once at boot" to a cached,
// refreshing SOURCE — so direct mode can consume a short-lived token from a credential helper (the pattern
// Claude Code's `apiKeyHelper` / kubectl exec-plugins use) that a static string can neither refresh nor send
// as a Bearer. The one `process.env` read (the `env` kind) goes through env.ts's seam so it stays the sole reader.

/** The wire scheme a resolved credential is sent under: the Anthropic `x-api-key` header, or `Authorization: Bearer`. */
export type CredentialScheme = "x-api-key" | "bearer";

/** A resolved wire credential. `expiresAt` (epoch ms) is absent for a source with no self-described lifetime. */
export type Credential = {
    readonly token: string;
    readonly scheme: CredentialScheme;
    readonly expiresAt?: number;
};

/** How a credential resolution failed — one actionable variant per boundary (env read, command spawn/exit, output parse). */
export type CredentialError =
    | { readonly type: "env_var_unset"; readonly var: string }
    | { readonly type: "command_spawn_failed"; readonly command: string; readonly cause: unknown }
    | { readonly type: "command_exit_nonzero"; readonly command: string; readonly exitCode: number; readonly stderr: string }
    | { readonly type: "command_empty_output"; readonly command: string }
    | { readonly type: "exec_credential_invalid"; readonly command: string; readonly detail: string };

/**
 * A cached async supplier of the wire credential. `get()` serves the cached token, refreshing once it ages
 * past its expiry (minus a safety buffer); `forceRefresh()` re-runs the source unconditionally — the reactive
 * path for an HTTP 401. Caching keyed on expiry means a command runs only on a real refresh, never per request.
 */
export type CredentialSource = {
    readonly get: () => Promise<Result<Credential, CredentialError>>;
    readonly forceRefresh: () => Promise<Result<Credential, CredentialError>>;
};

/** Render a {@link CredentialError} as an actionable one-line message for the chat error path and setup's probe. */
export function credentialErrorMessage(e: CredentialError): string {
    switch (e.type) {
        case "env_var_unset":
            return `environment variable ${e.var} is not set`;
        case "command_spawn_failed":
            return `credential command could not be run (${e.command}): ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`;
        case "command_exit_nonzero":
            return `credential command exited ${e.exitCode} (${e.command})${e.stderr.trim() ? `: ${e.stderr.trim()}` : ""}`;
        case "command_empty_output":
            return `credential command produced no token (${e.command})`;
        case "exec_credential_invalid":
            return `credential command output is not valid ExecCredential JSON (${e.command}): ${e.detail}`;
    }
}

/** Refresh a credential slightly ahead of its stated expiry, never in its final moments. */
const CREDENTIAL_REFRESH_BUFFER_MS = 30_000;
/** Lifetime for a raw command token with no self-described expiry — Claude Code's `apiKeyHelper` refresh cadence. */
const DEFAULT_RAW_TOKEN_TTL_MS = 5 * 60_000;

/**
 * The subset of a Kubernetes client-go `ExecCredential` this reads. `apiVersion` is required (so a plain blob
 * that merely carries `status.token` is not mistaken for one) but matched on the `client.authentication.k8s.io/`
 * prefix, not pinned to `v1`, so a helper emitting the equally-common `v1beta1` still interops.
 */
const execCredentialSchema = z.object({
    apiVersion: z.string().startsWith("client.authentication.k8s.io/"),
    status: z.object({
        token: z.string().min(1),
        expirationTimestamp: z.string().optional(),
    }),
});

/**
 * Run a credential command and capture its stdout, boundary-wrapped to a {@link Result}. Executed through
 * `sh -c` so a command string with arguments / flags / pipes runs exactly as a Claude Code `apiKeyHelper` would.
 */
async function runCredentialCommand(command: string): Promise<Result<string, CredentialError>> {
    try {
        // Inferred from the piped options (not annotated) so `proc.stdout`/`.stderr` narrow to `ReadableStream`.
        const proc = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (exitCode !== 0) return err({ type: "command_exit_nonzero", command, exitCode, stderr });
        return ok(stdout);
    } catch (cause) {
        // A spawn throw (missing shell / bad exec) and a stream-read throw both mean "the command could not be run".
        return err({ type: "command_spawn_failed", command, cause });
    }
}

/** Parse a credential command's stdout into a {@link Credential} per the configured format. */
function parseCommandCredential(
    command: string,
    stdout: string,
    scheme: CredentialScheme,
    format: "raw" | "exec-credential",
    ttlMs: number | undefined,
): Result<Credential, CredentialError> {
    if (format === "exec-credential") {
        let json: unknown; // command output — validated by execCredentialSchema below
        try {
            json = JSON.parse(stdout);
        } catch (cause) {
            return err({ type: "exec_credential_invalid", command, detail: cause instanceof Error ? cause.message : String(cause) });
        }
        const parsed = execCredentialSchema.safeParse(json);
        if (!parsed.success) {
            return err({ type: "exec_credential_invalid", command, detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        }
        const ts = parsed.data.status.expirationTimestamp;
        const expiresAt = ts !== undefined ? Date.parse(ts) : NaN;
        // An unparseable timestamp degrades to "no expiry" rather than an error: the token is valid, and the
        // 401 forceRefresh path still covers a rotation we didn't foresee.
        return ok({ token: parsed.data.status.token, scheme, ...(Number.isNaN(expiresAt) ? {} : { expiresAt }) });
    }
    const token = stdout.trim(); // raw: the whole stdout IS the token, minus the trailing newline — apiKeyHelper parity
    if (token === "") return err({ type: "command_empty_output", command });
    // A raw token describes no lifetime, so it ages off ttlMs (or the apiKeyHelper-default window) and is re-minted on expiry.
    return ok({ token, scheme, expiresAt: Date.now() + (ttlMs ?? DEFAULT_RAW_TOKEN_TTL_MS) });
}

/** Resolve one credential from its source config, uncached (the `env` read via env.ts's seam / the `command` run). */
async function resolveCredentialOnce(config: ModelAuthConfig): Promise<Result<Credential, CredentialError>> {
    if (config.kind === "env") {
        // Expiry-less: a rotated var is picked up when the user re-exports it, and a 401 forceRefresh re-reads it live.
        const token = readEnvCredentialVar(config.var);
        if (token === undefined) return err({ type: "env_var_unset", var: config.var });
        return ok({ token, scheme: config.scheme });
    }
    const out = await runCredentialCommand(config.command);
    return out.andThen((stdout) => parseCommandCredential(config.command, stdout, config.scheme, config.format ?? "raw", config.ttlMs));
}

/** True once a cached credential has aged within the refresh buffer of its expiry; an expiry-less credential never ages out. */
function credentialExpired(cred: Credential): boolean {
    return cred.expiresAt !== undefined && Date.now() >= cred.expiresAt - CREDENTIAL_REFRESH_BUFFER_MS;
}

/**
 * Build a cached, refreshing {@link CredentialSource} from a declarative {@link ModelAuthConfig}. Nothing runs
 * until the first {@link CredentialSource.get}; the result is cached until it ages past its expiry (minus
 * {@link CREDENTIAL_REFRESH_BUFFER_MS}) or {@link CredentialSource.forceRefresh} is called. The token is
 * obtained lazily and never logged or persisted — only the config's name/command/scheme are written to disk.
 */
export function createCredentialSource(config: ModelAuthConfig): CredentialSource {
    let cached: Credential | null = null;
    const refresh = async (): Promise<Result<Credential, CredentialError>> => {
        const resolved = await resolveCredentialOnce(config);
        if (resolved.isOk()) cached = resolved.value;
        return resolved;
    };
    return {
        get: () => (cached !== null && !credentialExpired(cached) ? Promise.resolve(ok(cached)) : refresh()),
        forceRefresh: refresh,
    };
}
