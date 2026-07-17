import { homedir } from "node:os";
import { join } from "node:path";
import { ok, err, type Result } from "neverthrow";
import { z } from "zod";
// Type-only (erased at compile): the declarative credential-source shape is owned by the config schema
// beside the model-connection block. lib/config.ts imports this module for `env`, so this back-reference
// stays type-only to avoid a runtime import cycle.
import type { ModelAuthConfig } from "./config.ts";

/**
 * True when this process is a `bun test` run whose sandbox preload never executed — the one condition
 * under which importing this module is a data-loss hazard rather than ordinary configuration.
 *
 * Split out from the import-time guard below purely so the truth table is unit-testable: the guard
 * reads `process.env` during module evaluation, so within a test process it has already run (or not)
 * and cannot be re-driven.
 */
export function isUnsandboxedTestRun(nodeEnv: string | undefined, sandboxMarker: string | undefined): boolean {
    return nodeEnv === "test" && !sandboxMarker;
}

// DATA-LOSS GUARD. A `bun test` process that reaches this module without the sandbox marker resolves
// every `env.*` path against the developer's REAL ~/.local/share/inflexa and ~/.config/inflexa — two
// live incidents began exactly there (full story: src/test_support/sandbox.ts). Bun reads bunfig from
// the cwd only, so `cli/bunfig.toml`'s preload (which redirects XDG_* and stamps INFLEXA_TEST_SANDBOX)
// covers only runs started in `cli/`; the root bunfig refuses the root run; this refuses every other
// cwd. Deny the PATHS, not each destructive call: a test cannot reach a `rmSync` with a real path in
// hand if the path never resolved. `assertTestSandbox` remains the per-site check for the one case
// this cannot see — a test that unsets the marker after this module is already imported.
//
// Inert outside `bun test`: a built binary has NODE_ENV --defined to its channel (scripts/build.ts),
// folding the comparison to a compile-time false; `bun run dev` leaves NODE_ENV unset; `runCli`
// forwards the parent's whole environment, marker included, so its subprocess passes.
//
// `throw`, not Result: module evaluation has no error channel, and a test-harness boundary's failure
// must stop the suite loudly. This is also the ONE sanctioned NODE_ENV read: it asks "is this a
// `bun test` process?", which only NODE_ENV can answer (the build channel is unset in both a source
// run and a test run) — and the literal dot access is what lets the build's --define eliminate the
// branch in a shipped binary.
// eslint-disable-next-line no-restricted-syntax -- the one sanctioned NODE_ENV read; see above
if (isUnsandboxedTestRun(process.env.NODE_ENV, process.env.INFLEXA_TEST_SANDBOX)) {
    throw new Error(
        "refusing to resolve inflexa paths: test sandbox not active — NODE_ENV=test but INFLEXA_TEST_SANDBOX is unset, so env.* would point at your real data. Run `bun test` from cli/ so bunfig's preload redirects XDG_* and stamps the marker.",
    );
}

const dataVar = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
const configVar = process.platform === "win32" ? "APPDATA" : "XDG_CONFIG_HOME";
const logLevelVar = "INFLEXA_LOG_LEVEL";
const otelEndpointVar = "OTEL_EXPORTER_OTLP_ENDPOINT";
const modelApiKeyVar = "INFLEXA_MODEL_API_KEY";
// The ecosystem-conventional provider variables a `direct` connection can read/adopt. The API-key vars
// are the provider-derived FALLBACK for the direct-mode secret (after INFLEXA_MODEL_API_KEY); the
// *_BASE_URL vars are read ONLY for one-time setup detection (never a runtime endpoint binding). Homed
// here because env.ts is the sole `process.env` reader — see resolveModelApiKey / detectProviderEnv.
const anthropicApiKeyVar = "ANTHROPIC_API_KEY";
const openaiApiKeyVar = "OPENAI_API_KEY";
const anthropicBaseUrlVar = "ANTHROPIC_BASE_URL";
const openaiBaseUrlVar = "OPENAI_BASE_URL";
// The Anthropic-wire BEARER token variable. A short-lived first-party token (WIF / gateway / enterprise
// credential) rather than a static `x-api-key`; consumed as a `direct`-mode credential source via a
// configured `{ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" }` auth block, and detected by
// setup. Read here (the sole `process.env` reader) — see {@link anthropicAuthTokenSet}.
const anthropicAuthTokenVar = "ANTHROPIC_AUTH_TOKEN";

function dataDir(): string {
    const base = process.env[dataVar];
    if (base) return base;
    return process.platform === "win32" ? join(homedir(), "AppData", "Local") : join(homedir(), ".local", "share");
}

function configDir(): string {
    const base = process.env[configVar];
    if (base) return base;
    return process.platform === "win32" ? join(homedir(), "AppData", "Roaming") : join(homedir(), ".config");
}

/**
 * CLIProxyAPI listens on this fixed port inside the container we manage
 * (src/modules/infra/setup.ts publishes it) and the chat backend connects to it.
 * We own the container, so the endpoint is intentionally NOT user-overridable — it is
 * not read from process.env. If we ever let users choose the port, derive the
 * URLs from it right here.
 */
const cliproxyPort = 8317;

/**
 * Default host-published port for the inflexa-postgres container. Off the standard
 * 5432 (clashes with a user's system PG) and 5433 (claimed by the harness testcontainer).
 * Rhymes with the proxy's owned port 8317. User-overridable via config.json.
 */
const postgresPort = 8432;

/**
 * Internal configuration baked into release binaries: `bun run build` inlines
 * each value via --define, so the compiled executable never consults the
 * runtime environment for them — end users cannot override them, and they are
 * deliberately absent from envDoc/--help. Dev runs (`bun run dev`) fall back
 * to runtime env/.env through these same expressions. The literal dot access
 * is load-bearing: the bundler only inlines static `process.env.X` member
 * expressions, never dynamic `process.env[name]` reads. To bake a new value,
 * just add its dot access here — scripts/build.ts derives the baked-var list
 * from this block, so there is nothing else to keep in sync.
 */
// Deferred so the spawnSync only runs when the value is first read (provenance actor, --version), not
// on every CLI startup. INFLEXA_GIT_COMMIT is NOT in the bakedEnv block below — its requirement is
// channel-conditional, and that block's scanner would demand it of every build — so scripts/build.ts
// emits its --define explicitly, gated on a production channel. In a production binary that --define
// makes the first read a string literal and the rest of this function unreachable.
let _gitCommit: string | undefined;
function resolveGitCommit(): string {
    if (process.env.INFLEXA_GIT_COMMIT) return process.env.INFLEXA_GIT_COMMIT;
    // Reaching here in a production build means the artifact bypassed scripts/build.ts (a hand-rolled
    // `bun build`, a patched script). Its own gate already refuses that combination, so this is a
    // backstop, not the enforcement point — but the failure it guards against is silently stamping
    // provenance with a commit resolved from whatever tree the USER happens to be standing in, so it
    // must still crash rather than shell out. Keyed on the baked channel, NOT NODE_ENV: the same
    // --define makes this literal "production" === "production" in a shipped binary, whereas NODE_ENV
    // would be an unguarded runtime read.
    if (process.env.INFLEXA_BUILD_CHANNEL === "production")
        throw new Error("INFLEXA_GIT_COMMIT is not set in a production build. This means the binary was not built correctly.");

    // Dev-only path: resolve from the working tree's HEAD.
    const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
    if (!sha) throw new Error("Could not resolve git HEAD — are you running outside a git checkout?");
    return sha;
}

export const bakedEnv = Object.freeze({
    auth0Domain: process.env.INFLEXA_AUTH0_DOMAIN,
    auth0ClientId: process.env.INFLEXA_AUTH0_CLIENT_ID,
    auth0Audience: process.env.INFLEXA_AUTH0_AUDIENCE,
    // Build channel — `production` | `development` — baked at build time so a shipped binary's
    // identity is fixed at compile and cannot be swayed by the user's runtime environment. The literal
    // `process.env.INFLEXA_BUILD_CHANNEL` dot access is load-bearing: scripts/build.ts scans this block
    // for exactly that pattern to learn which vars to --define, and its missing-var guard rejects an
    // empty/unset value — so a build MUST declare the channel. `bun run dev` leaves it unset (→ undefined
    // → development). This is the ONE signal both `env.isDevelopment` (via isDevelopmentBuild) and
    // `devCommandsEnabled` derive from. We deliberately do NOT read NODE_ENV here: it is the ecosystem's
    // signal for how BUNDLED DEPENDENCIES compile, a separate axis. scripts/build.ts --defines NODE_ENV
    // from this same channel value, so the two are coupled at the single build authority and cannot drift
    // (a `production` binary with a `development` NODE_ENV would ship prod-gated code atop dev-mode deps).
    buildChannel: process.env.INFLEXA_BUILD_CHANNEL,
    get gitCommit(): string {
        if (_gitCommit === undefined) _gitCommit = resolveGitCommit();
        return _gitCommit;
    },
});

/**
 * The pure decision behind `env.isDevelopment`, split out so its truth table is unit-testable: `env`
 * freezes its `bakedEnv.buildChannel` read at import, so the flag's own input cannot be varied within
 * a test process. A build is development unless the `production` channel was baked in — the source-run
 * default (unset channel) is development. Deliberately does NOT honor the `INFLEXA_DEV=1` escape hatch
 * that {@link devCommandsActive} adds: that re-enables dev *commands* on a shipped binary for support,
 * but must not also repoint container names / harness skills+templates dirs at the dev repo checkout.
 */
export function isDevelopmentBuild(channel: string | undefined): boolean {
    return channel !== "production";
}

export const env = Object.freeze({
    dbPath: join(dataDir(), "inflexa", "agent.db"),
    logDir: join(dataDir(), "inflexa", "logs"),
    /**
     * Public reference-data store. Deliberate setup/download actions create this path; passive
     * runtime composition only checks whether it exists before offering it to the harness.
     */
    refsDir: join(dataDir(), "inflexa", "refs"),
    /**
     * Materialized skills/templates content: `<dataDir>/inflexa/content/<contentHash>/{skills,templates}`.
     * A peer of `refsDir`/`modelDir` — a runtime asset tree, not config — but sourced from the binary's
     * OWN embedded archive rather than a network download (see modules/harness/content.ts). The
     * `<contentHash>` segment (see {@link env.contentHash}) makes a new binary version extract a fresh
     * tree on first run, so updates ride the install. Only ever written/read in a release build; a dev
     * run points skills/templates at the repo checkout and never touches this path.
     */
    contentDir: join(dataDir(), "inflexa", "content"),
    /**
     * Advisory instance locks: `<dataDir>/inflexa/locks/<key>.lock`, keyed by an analysis id (one
     * inflexa process may have an analysis open at a time) or a fixed sentinel for the embedded harness
     * runtime (one DBOS engine per machine). The lock files coordinate that across instances.
     * See src/lib/lock.ts.
     */
    locksDir: join(dataDir(), "inflexa", "locks"),
    /**
     * Local embedding model storage: `<dataDir>/inflexa/models/`. The GGUF for
     * `bge-small-en-v1.5` (q8_0, 384-dim) is downloaded here on `inflexa setup --embeddings`
     * opt-in. See src/modules/embedding/setup.ts.
     */
    modelDir: join(dataDir(), "inflexa", "models"),
    /** The local embedding GGUF path — `<modelDir>/bge-small-en-v1.5-q8_0.gguf`. */
    embeddingModelPath: join(dataDir(), "inflexa", "models", "bge-small-en-v1.5-q8_0.gguf"),
    /**
     * Local embedding sidecar runtime: `<dataDir>/inflexa/llama-server/`. The pinned `llama.cpp`
     * release (the `llama-server` binary + its shared libraries) is materialized into a tag-named
     * subdirectory here on `inflexa setup --embeddings local` opt-in — extracted from a build-time
     * embedded asset in the compiled binary, downloaded from source. See
     * src/modules/embedding/llama_runtime.ts.
     */
    llamaServerDir: join(dataDir(), "inflexa", "llama-server"),
    /**
     * CLIProxyAPI runs in a container (Docker or Podman, see
     * src/modules/infra/setup.ts). The config and the provider-credential dir are
     * state we own, so they live under our data dir and are bind-mounted into the
     * container.
     */
    cliproxyConfigPath: join(dataDir(), "inflexa", "cliproxy", "config.yaml"),
    cliproxyAuthDir: join(dataDir(), "inflexa", "cliproxy", "auth"),
    /**
     * Postgres data directory — bind-mounted into the inflexa-postgres container at
     * `/var/lib/postgresql` (the PG 18+ parent mount) so DB state persists across CLI restarts. See
     * src/modules/infra/postgres.ts.
     */
    postgresDataDir: join(dataDir(), "inflexa", "postgres"),
    /**
     * Docker Compose file — generated by `inflexa setup` to orchestrate both the
     * proxy and Postgres containers on a shared network. Regenerated on every setup
     * run; the launch-time gate generates it if missing.
     */
    composeFilePath: join(dataDir(), "inflexa", "docker-compose.yml"),
    configPath: join(configDir(), "inflexa", "config.json"),
    authPath: join(configDir(), "inflexa", "auth.json"),
    provKeyPath: join(configDir(), "inflexa", "prov_key.json"),
    logLevel: process.env[logLevelVar],
    otelEndpoint: process.env[otelEndpointVar],
    /**
     * CLIProxyAPI networking — internal constants, deliberately excluded from
     * envDoc/--help (see the Exclude on envDoc below).
     */
    cliproxyPort,
    cliproxyBaseUrl: `http://localhost:${cliproxyPort}`, // human-facing, no /v1
    cliproxyApiUrl: `http://localhost:${cliproxyPort}/v1`, // chat backend endpoint
    postgresPort,
    /**
     * The build-baked identity of the embedded skills/templates archive — a short hash over the
     * archived file set (see scripts/build.ts), naming the {@link env.contentDir} subdirectory the
     * release binary extracts into. `--define`d at build time exactly like `INFLEXA_GIT_COMMIT` (an
     * EXPLICIT define, deliberately NOT in the {@link bakedEnv} scanner block — that block's missing-var
     * guard applies to every channel and would reject a development build, which legitimately has no
     * archive). Hence `string | undefined`: a `bun run dev` process has no baked value, and the dev
     * skills/templates resolution never reads this.
     */
    contentHash: process.env.INFLEXA_CONTENT_HASH,
    /**
     * True unless the `production` channel was baked in — {@link isDevelopmentBuild} over
     * {@link bakedEnv.buildChannel}, never NODE_ENV (the buildChannel note above owns the
     * one-axis rationale). Governs dev-only runtime layout: the compose container/network prefix
     * (src/modules/infra/compose.ts) and the harness skills/templates dirs (src/modules/harness/config.ts).
     */
    isDevelopment: isDevelopmentBuild(bakedEnv.buildChannel),
});

/**
 * The provider-conventional API-key variable NAME for `provider` — `ANTHROPIC_API_KEY` for `anthropic`,
 * `OPENAI_API_KEY` for every other provider. The name only, never the value: used to name the tried
 * fallback in the boot key-missing error and setup's guidance, so those messages stay honest without a
 * second `process.env` reader. See {@link resolveModelApiKey} for the resolution that consumes it.
 */
export function providerApiKeyVar(provider: string): string {
    return provider === "anthropic" ? anthropicApiKeyVar : openaiApiKeyVar;
}

/**
 * Resolve the `direct`-connection chat API key from the environment ONLY (env.ts is the sole
 * `process.env` reader), parameterized by the connection's configured `provider`. Precedence:
 * `INFLEXA_MODEL_API_KEY` (the explicit override) first; when unset, the provider-conventional variable
 * ({@link providerApiKeyVar}) so a machine already provisioned for Claude Code / the SDKs works without
 * re-exporting the key under a new name. Consumed only at provider construction / model listing; the
 * resolved value is NEVER written to config.json, telemetry, logs, or provenance — the provider-derived
 * fallback READS an existing ecosystem secret, it never copies it. Ignored in `cliproxy` mode, which
 * mints and reads its own client key.
 *
 * Read at call time, not import (unlike the frozen `env` fields), so it reflects the live environment —
 * correct for a value that may be exported after this module loads, and what makes it unit-testable.
 *
 * This is the DEFAULT credential path (static env key, sent as the wire protocol's conventional header). A
 * connection that configures an `auth` block instead supplies a refreshing source that takes precedence —
 * including the Anthropic-wire Bearer case (`ANTHROPIC_AUTH_TOKEN`), now reachable via
 * `{ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" }` (see {@link createCredentialSource}).
 * Still out of scope here: Bedrock/Vertex (no direct-mode HTTP `/v1` signer).
 */
export function resolveModelApiKey(provider: string): string | undefined {
    return process.env[modelApiKeyVar] ?? process.env[providerApiKeyVar(provider)];
}

/**
 * True when {@link anthropicAuthTokenVar} (`ANTHROPIC_AUTH_TOKEN`) is set — the env signal of a bearer-token
 * Anthropic setup. Read here because env.ts is the sole `process.env` reader; setup consumes it (never the
 * value) to OFFER the `{ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" }` credential source.
 */
export function anthropicAuthTokenSet(): boolean {
    return Boolean(process.env[anthropicAuthTokenVar]);
}

// --- direct-mode credential source -----------------------------------------
//
// A `direct` connection's wire credential, generalized from "a static key read once at boot" to a cached,
// refreshing SOURCE. This lets `direct` mode consume a short-lived first-party token from a credential
// helper (the pattern Claude Code's `apiKeyHelper` / kubectl exec-plugins use) that a static string can
// neither refresh nor send as a Bearer. env.ts owns it because it reads `process.env` (the `env` kind) and
// runs the configured command (the `command` kind) — both credential-material boundaries the rest of the
// codebase reaches only through here.

/** The wire scheme a resolved credential is sent under: the Anthropic `x-api-key` header, or `Authorization: Bearer`. */
export type CredentialScheme = "x-api-key" | "bearer";

/**
 * A resolved wire credential: the token to send, the scheme to send it under, and an OPTIONAL absolute
 * expiry (epoch ms). `expiresAt` is absent for a source with no self-described lifetime (a static env var);
 * {@link createCredentialSource} still ages a raw command token off its `ttlMs`, so an absent `expiresAt`
 * here means "cache until an explicit forceRefresh" — never a per-request re-resolution.
 */
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
 * A cached async supplier of the wire credential. `get()` returns the cached token, transparently
 * refreshing when it has aged past its expiry (minus a safety buffer); `forceRefresh()` re-runs the
 * underlying source unconditionally — the reactive path for an HTTP 401 (a token rotated out from under the
 * cache). Caching keyed on expiry means a credential COMMAND runs only on a real refresh, never per request.
 */
export type CredentialSource = {
    readonly get: () => Promise<Result<Credential, CredentialError>>;
    readonly forceRefresh: () => Promise<Result<Credential, CredentialError>>;
};

/** Render a {@link CredentialError} as an actionable one-line message — the wire boundary surfaces it to the chat error path, and setup's probe names it as the likely cause. */
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

/** Safety margin subtracted from a credential's expiry so it is refreshed slightly early, never used in its final moments. */
const CREDENTIAL_REFRESH_BUFFER_MS = 30_000;
/** Default lifetime for a raw command token with no self-described expiry and no configured `ttlMs` — Claude Code's `apiKeyHelper` refresh cadence. */
const DEFAULT_RAW_TOKEN_TTL_MS = 5 * 60_000;

/**
 * The subset of a Kubernetes client-go `ExecCredential` this reads: the minted token and its optional
 * expiry. `apiVersion` is required present (so a plain JSON blob that merely happens to carry `status.token`
 * is not mistaken for one) but matched only on the `client.authentication.k8s.io/` prefix rather than pinned
 * to `v1`, so a helper emitting the equally-common `v1beta1` still interops — the interop guarantee is the
 * whole point of adopting the standard shape. See the client-authentication API reference.
 */
const execCredentialSchema = z.object({
    apiVersion: z.string().startsWith("client.authentication.k8s.io/"),
    status: z.object({
        token: z.string().min(1),
        expirationTimestamp: z.string().optional(),
    }),
});

/**
 * Run a credential command and capture its stdout, boundary-wrapped to a {@link Result} (Bun.spawn and the
 * stream reads throw). Executed through the system shell (`sh -c`) so a configured command string with
 * arguments / flags / pipes runs exactly as a Claude Code `apiKeyHelper` would.
 */
async function runCredentialCommand(command: string): Promise<Result<string, CredentialError>> {
    try {
        // `proc` is inferred from the piped options here (not annotated), so `proc.stdout`/`.stderr` narrow
        // to `ReadableStream` — an outer type annotation would widen them back to the generic union.
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
        // A present-but-unparseable timestamp degrades to "no self-described expiry" rather than an error:
        // the token itself is valid, and the 401 forceRefresh path still covers a rotation we didn't foresee.
        return ok({ token: parsed.data.status.token, scheme, ...(Number.isNaN(expiresAt) ? {} : { expiresAt }) });
    }
    // raw: the whole stdout IS the token, trimmed of the trailing newline a helper prints — apiKeyHelper parity.
    const token = stdout.trim();
    if (token === "") return err({ type: "command_empty_output", command });
    // A raw token describes no lifetime, so it ages off ttlMs (or the apiKeyHelper-default window) and is re-minted on expiry.
    return ok({ token, scheme, expiresAt: Date.now() + (ttlMs ?? DEFAULT_RAW_TOKEN_TTL_MS) });
}

/** Resolve one credential from its source config, uncached (the `env` read / the `command` run). */
async function resolveCredentialOnce(config: ModelAuthConfig): Promise<Result<Credential, CredentialError>> {
    if (config.kind === "env") {
        const token = process.env[config.var];
        if (token === undefined || token === "") return err({ type: "env_var_unset", var: config.var });
        // An env token is expiry-less: a rotated ANTHROPIC_AUTH_TOKEN is picked up when the user re-exports it,
        // and a 401 forceRefresh re-reads the live variable.
        return ok({ token, scheme: config.scheme });
    }
    const out = await runCredentialCommand(config.command);
    return out.andThen((stdout) => parseCommandCredential(config.command, stdout, config.scheme, config.format ?? "raw", config.ttlMs));
}

/** True once a cached credential has aged to within the refresh buffer of its expiry; an expiry-less credential never ages out (only forceRefresh replaces it). */
function credentialExpired(cred: Credential): boolean {
    return cred.expiresAt !== undefined && Date.now() >= cred.expiresAt - CREDENTIAL_REFRESH_BUFFER_MS;
}

/**
 * Build a cached, refreshing {@link CredentialSource} from a declarative {@link ModelAuthConfig}. Nothing
 * runs until the first {@link CredentialSource.get}; the result is then cached until it ages past its expiry
 * (minus {@link CREDENTIAL_REFRESH_BUFFER_MS}) or {@link CredentialSource.forceRefresh} is called. The `env`
 * kind reads a named variable; the `command` kind runs the command and parses its stdout as a raw token
 * (default) or Kubernetes ExecCredential JSON. The token value is obtained lazily by the returned source and
 * NEVER logged or persisted — only this config's name/command/scheme are ever written to disk.
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

/**
 * Wrap an already-resolved static token (the environment key resolved via {@link resolveModelApiKey}) as an
 * expiry-less {@link CredentialSource}, so the wire path is UNIFORM: `direct` mode always injects its
 * credential through the same source seam whether the token comes from a configured `auth` block or the plain
 * env key. `forceRefresh` returns the same token — a static env key has nothing to re-mint.
 */
export function staticCredentialSource(token: string, scheme: CredentialScheme): CredentialSource {
    const credential: Credential = { token, scheme };
    const resolve = (): Promise<Result<Credential, CredentialError>> => Promise.resolve(ok(credential));
    return { get: resolve, forceRefresh: resolve };
}

/**
 * The presence + endpoint facts of the conventional provider environment, for `inflexa setup`'s
 * one-time direct-path adoption (see modules/infra/setup.ts). Deliberately reports only WHETHER each API
 * key is set — never its value — because setup copies only the non-secret `{ provider, baseURL, protocol }`
 * into config; the key stays an environment read via {@link resolveModelApiKey}. The `*_BASE_URL` values
 * are the RAW convention (asymmetric: `ANTHROPIC_BASE_URL` is a bare root, `OPENAI_BASE_URL` is usually
 * already `/v1`-terminated); setup normalizes them before offering the pre-fill.
 */
export type ProviderEnvSnapshot = {
    /** `ANTHROPIC_API_KEY` is set (value withheld — setup never copies the key). */
    readonly anthropicApiKeySet: boolean;
    /** `ANTHROPIC_BASE_URL` if set — a BARE root by convention (the Anthropic SDK appends `/v1/…`). */
    readonly anthropicBaseURL: string | undefined;
    /** `OPENAI_API_KEY` is set. */
    readonly openaiApiKeySet: boolean;
    /** `OPENAI_BASE_URL` if set — usually already `/v1`-terminated. */
    readonly openaiBaseURL: string | undefined;
};

/**
 * Snapshot the conventional provider environment for setup's direct-path detection. The SOLE reader of
 * the ecosystem `*_BASE_URL` variables — a one-time setup read, never a runtime endpoint binding (boot
 * resolves the endpoint from config only). Read at call time so `inflexa setup` sees the live shell.
 */
export function detectProviderEnv(): ProviderEnvSnapshot {
    return {
        anthropicApiKeySet: Boolean(process.env[anthropicApiKeyVar]),
        anthropicBaseURL: process.env[anthropicBaseUrlVar] || undefined,
        openaiApiKeySet: Boolean(process.env[openaiApiKeyVar]),
        openaiBaseURL: process.env[openaiBaseUrlVar] || undefined,
    };
}

/**
 * True when the dev/E2E command surface (`chat`, `profile`, `run`) should be registered.
 * A production build bakes `INFLEXA_BUILD_CHANNEL=production` and gets a product-only surface; any
 * other channel — notably the unset development default of `bun run dev` — enables them. `INFLEXA_DEV=1`
 * is a deliberate runtime escape hatch: it is intentionally NOT in `bakedEnv`, so it is never
 * --define-inlined and stays a live `process.env` read even inside a compiled production binary,
 * letting support re-enable the dev commands on a shipped build without a rebuild. See the
 * dev-commands spec.
 */
export function devCommandsEnabled(): boolean {
    return devCommandsActive(bakedEnv.buildChannel, process.env.INFLEXA_DEV);
}

/**
 * The pure decision behind {@link devCommandsEnabled}, split out only so its truth table is unit
 * testable: `env`/`bakedEnv` freeze their `process.env` reads at import, so the accessor's own
 * inputs cannot be varied within a test process. It is {@link isDevelopmentBuild} (the same
 * baked-channel axis `env.isDevelopment` uses) widened by the `INFLEXA_DEV=1` runtime escape hatch.
 */
export function devCommandsActive(channel: string | undefined, devOverride: string | undefined): boolean {
    return isDevelopmentBuild(channel) || devOverride === "1";
}

export type EnvDocEntry = { kind: "path"; label: string; description: string; baseVar: string } | { kind: "var"; name: string; description: string };

/** Rendered into the Paths/Environment sections of --help (src/cli/index.ts). */
export const envDoc: Readonly<
    Record<Exclude<keyof typeof env, "cliproxyPort" | "cliproxyBaseUrl" | "cliproxyApiUrl" | "postgresPort" | "isDevelopment" | "contentHash">, EnvDocEntry>
> = Object.freeze({
    dbPath: { kind: "path", label: "database", description: "saved sessions (SQLite)", baseVar: dataVar },
    logDir: { kind: "path", label: "logs", description: "log files, rotated daily, 7-day retention", baseVar: dataVar },
    refsDir: {
        kind: "path",
        label: "references",
        description: "reference data mounted read-only in sandboxes at /mnt/refs",
        baseVar: dataVar,
    },
    contentDir: {
        kind: "path",
        label: "content",
        description: "skills/templates extracted from the binary on first run, keyed by content hash",
        baseVar: dataVar,
    },
    locksDir: { kind: "path", label: "locks", description: "advisory per-analysis instance locks", baseVar: dataVar },
    modelDir: { kind: "path", label: "models", description: "local embedding GGUF models, downloaded by `inflexa setup --embeddings`", baseVar: dataVar },
    embeddingModelPath: {
        kind: "path",
        label: "embedding model",
        description: "the bge-small-en-v1.5 GGUF used by the local embedding provider",
        baseVar: dataVar,
    },
    llamaServerDir: {
        kind: "path",
        label: "llama runtime",
        description: "pinned llama-server runtime for local embeddings, materialized by `inflexa setup --embeddings local`",
        baseVar: dataVar,
    },
    cliproxyConfigPath: { kind: "path", label: "proxy config", description: "CLIProxyAPI config, mounted into the proxy container", baseVar: dataVar },
    cliproxyAuthDir: { kind: "path", label: "proxy auth", description: "CLIProxyAPI provider credentials, created by `inflexa setup`", baseVar: dataVar },
    postgresDataDir: {
        kind: "path",
        label: "postgres data",
        description: "Postgres data dir, bind-mounted into the inflexa-postgres container",
        baseVar: dataVar,
    },
    composeFilePath: {
        kind: "path",
        label: "compose file",
        description: "Docker Compose file orchestrating the proxy and Postgres containers",
        baseVar: dataVar,
    },
    configPath: { kind: "path", label: "config", description: "settings (telemetry consent)", baseVar: configVar },
    authPath: { kind: "path", label: "auth", description: "Auth0 session tokens, created by `inflexa auth login`", baseVar: configVar },
    provKeyPath: { kind: "path", label: "provenance key", description: "Ed25519 keypair for signing provenance chain hashes", baseVar: configVar },
    logLevel: { kind: "var", name: logLevelVar, description: "log verbosity: trace|debug|info|warn|error|fatal (default: info)" },
    otelEndpoint: { kind: "var", name: otelEndpointVar, description: "OTLP endpoint for log export; requires telemetry enabled via `inflexa config`" },
});

/**
 * `--help` documentation for the direct-connection secret channel — vars that are NOT backed by an `env`
 * field because they are resolved on demand by {@link resolveModelApiKey} (parameterized by provider),
 * not eagerly read into the frozen `env`. Kept separate from {@link envDoc} precisely because that record
 * is key-locked to `env`'s fields: surfacing these as `env` fields would widen the secret's surface for
 * no gain. Rendered alongside `envDoc`'s var rows by src/cli/index.ts.
 *
 * `ANTHROPIC_AUTH_TOKEN` is consumed not as a bare env fallback here but via a configured `direct`-mode
 * `auth` block (`{ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" }`) — see
 * {@link createCredentialSource}; setup offers it when detected. Bedrock/Vertex remain out of scope
 * (no direct-mode HTTP signer).
 */
export const modelConnectionEnvDoc: readonly { readonly name: string; readonly description: string }[] = Object.freeze([
    {
        name: modelApiKeyVar,
        description:
            'API key for a direct model connection (config `models.connection.mode: "direct"`) — the explicit override, tried first; unused with the default managed proxy',
    },
    {
        name: `${anthropicApiKeyVar} / ${openaiApiKeyVar}`,
        description:
            "provider-conventional fallback for the direct-connection key when INFLEXA_MODEL_API_KEY is unset (ANTHROPIC_API_KEY for provider anthropic, OPENAI_API_KEY otherwise); read from the environment only, never persisted",
    },
]);

// Dev-tooling paths for `bun run dev:install` (scripts/dev_install.ts): where the `inflexa`
// executable is placed on PATH, and where `wipe`'s `repo` target removes it. Homed here so the
// OS path logic lives beside the app's other path derivations, but deliberately OUT of
// `env`/`envDoc` — the compiled binary's users never install it, so it is not a runtime path.

/**
 * The directory `dev:install` puts `inflexa` in, defaulting to a no-sudo, user-writable dir:
 * - macOS/Linux: `~/.local/bin` — the XDG/freedesktop convention for user executables. We avoid
 *   `/usr/local/bin` because it is root-owned on Apple Silicon (Homebrew moved to `/opt/homebrew`),
 *   so a plain install there fails with EACCES.
 * - Windows: `%LOCALAPPDATA%\Microsoft\WindowsApps` — user-writable and on PATH by default.
 *
 * `INFLEXA_INSTALL_DIR` overrides it (e.g. `/usr/local/bin` with sudo, or a Homebrew prefix).
 */
export function installDir(): string {
    const override = process.env.INFLEXA_INSTALL_DIR;
    if (override) return override;
    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
        return join(localAppData, "Microsoft", "WindowsApps");
    }
    return join(homedir(), ".local", "bin");
}

/** Absolute path of the dev-installed `inflexa` executable (`.exe` on Windows). See {@link installDir}. */
export function installedBinPath(): string {
    return join(installDir(), process.platform === "win32" ? "inflexa.exe" : "inflexa");
}

/**
 * Terminal-environment detection for the clipboard writer (src/lib/clipboard.ts), homed here because
 * env.ts is the single sanctioned `process.env` reader. These are NOT inflexa configuration — they are
 * terminal-multiplexer / display-server facts (the same category as `process.stdout.isTTY`), so they
 * live OUTSIDE the `env`/`envDoc` config object and never appear in `--help`. All three vars are set
 * at process startup and stable for its lifetime, so reading them once at module load is correct.
 */
export const terminalEnv = Object.freeze({
    /** tmux or GNU screen is wrapping us — OSC 52 clipboard writes need DCS passthrough to escape it. */
    multiplexed: Boolean(process.env.TMUX || process.env.STY),
    /** Running under Wayland — the clipboard tool is `wl-copy` rather than X11's `xclip`. */
    wayland: Boolean(process.env.WAYLAND_DISPLAY),
});
