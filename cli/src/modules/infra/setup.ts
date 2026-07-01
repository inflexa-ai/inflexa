import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { intro, outro, log, note, spinner as clackSpinner } from "@clack/prompts";
import { type Result, ok, err } from "neverthrow";
import { activeRuntime, readConfig, resolvePostgresConfig, writeConfig } from "../../lib/config.ts";
import { ensureReady, ContainerRuntimeError, type ContainerRuntime } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { select, promptText } from "../../lib/cli.ts";
import { type PostgresConnection } from "./postgres_types.ts";
import { writeComposeFile, composeUp, composePull, composePullIfMissing, composeAvailable } from "./compose.ts";

// `inflexa setup` provisions the inflexa infrastructure stack: CLIProxyAPI (the
// local model proxy) and Postgres + pgvector (the harness substrate). Both run
// as Docker/Podman containers orchestrated via a generated Docker Compose file
// that places them on a shared `inflexa` network.
//
// State we own — the proxy config, provider credentials, postgres data — lives
// under our data dir and is bind-mounted into the containers. The compose file
// is generated into the data dir and regenerated on every setup run.
//
// The proxy lifecycle, auth plumbing, and the setup orchestrator live here (the
// `infra` module — infrastructure provisioning). The Postgres-specific readiness
// gate and vector self-install live in modules/infra/postgres.ts.

// --- command ---------------------------------------------------------------

type SetupOptions = {
    /** Commander fills these in from the flags registered in src/cli/index.ts. */
    provider?: string;
    auth: boolean;
    start: boolean;
    force: boolean;
    /** Whether to provision Postgres (default true; `--no-postgres` sets false). */
    postgres: boolean;
};

export async function setup(options: SetupOptions): Promise<void> {
    const provider = resolveProvider(options).match(
        (p) => p,
        (e) => {
            console.error(`\n  ${e.message}\n`);
            process.exitCode = 1;
            return null as Provider | undefined | null;
        },
    );
    if (provider === null) return;
    const rt = activeRuntime();

    const readyResult = await ensureReady(rt);
    if (readyResult.isErr()) {
        console.error(`\n  ${readyResult.error.message}\n`);
        process.exitCode = 1;
        return;
    }

    intro("inflexa setup");

    try {
        // --- proxy config ---
        const { created, apiKey } = await writeProxyConfig();
        if (created) {
            log.success(`Wrote proxy config at ${env.cliproxyConfigPath}`);
            if (apiKey) {
                note(apiKey, "Client API key (use this to call the proxy)");
            }
        } else {
            log.info(`Proxy config exists at ${env.cliproxyConfigPath}`);
        }

        // --- provider auth ---
        if (options.auth) {
            if (provider === undefined && (await isAuthenticated())) {
                log.info("Already authenticated — use `--provider <name>` to add or switch.");
            } else {
                const authed = await authenticate(rt, provider);
                if (!authed) log.warn("No provider authenticated yet — re-run `inflexa setup` to sign in.");
            }
        }

        // --- postgres config ---
        let pgConn: PostgresConnection;
        if (options.postgres) {
            pgConn = await promptPostgresConfig();

            if (!(await composeAvailable(rt))) {
                log.error(`${rt.label} Compose is not available.\n  Install it: https://docs.docker.com/compose/install/`);
                process.exitCode = 1;
                return;
            }

            const s = clackSpinner();

            s.start("Generating Docker Compose file");
            const composeWriteErr = writeComposeFile(pgConn).match(
                () => null,
                (e) => e,
            );
            if (composeWriteErr) {
                s.error("Failed to write compose file");
                log.error(composeWriteErr.message);
                process.exitCode = 1;
                return;
            }
            s.stop("Compose file ready");

            if (options.force) {
                s.start("Pulling images (this may take a moment)");
                const pullResult = await composePull(rt);
                if (pullResult.isErr()) {
                    s.error("Image pull failed");
                    log.error(pullResult.error.message);
                    process.exitCode = 1;
                    return;
                }
                s.stop("Images pulled");
            }

            if (options.start) {
                s.start("Starting containers");
                const upResult = await composeUp(rt);
                if (upResult.isErr()) {
                    s.error("Failed to start containers");
                    log.error(upResult.error.message);
                    process.exitCode = 1;
                    return;
                }
                s.stop("Containers running");

                s.start("Waiting for Postgres");
                const { provisionPostgres } = await import("./postgres.ts");
                const pgResult = await provisionPostgres({ start: true, force: options.force, postgres: true });
                if (pgResult.isErr()) {
                    s.error("Postgres provisioning failed");
                    log.error(pgResult.error.message);
                    process.exitCode = 1;
                    return;
                }
                s.stop("Postgres ready with pgvector");
            }
        } else {
            pgConn = resolvePostgresConfig();
        }

        printNextSteps(options, pgConn);
        outro("Setup complete");
    } catch (error) {
        log.error(`Setup failed unexpectedly: ${error}`);
        process.exitCode = 1;
    }
}

/**
 * Prompt for Postgres username, password, and port via @clack/prompts.
 * On non-interactive terminals, uses existing config values or defaults silently.
 * Empty input keeps the current value (the default is shown in the placeholder).
 */
async function promptPostgresConfig(): Promise<PostgresConnection> {
    const existing = resolvePostgresConfig();

    if (!process.stdin.isTTY) return existing;

    log.message("Configure Postgres (press Enter to accept defaults)");

    const user = await promptText("Username", {
        defaultValue: existing.user,
        placeholder: existing.user,
    }).catch(() => existing.user);
    const password = await promptText("Password", {
        defaultValue: existing.password,
        placeholder: existing.password,
    }).catch(() => existing.password);
    const portStr = await promptText("Port", {
        defaultValue: String(existing.port),
        placeholder: String(existing.port),
        validate: (v) => {
            if (v.trim() === "") return undefined;
            const n = Number(v.trim());
            if (!Number.isInteger(n) || n <= 0 || n > 65535) return "Must be a valid port number (1-65535).";
            return undefined;
        },
    }).catch(() => String(existing.port));

    const port = Number(portStr) || existing.port;

    const conn: PostgresConnection = {
        host: existing.host,
        port,
        database: existing.database,
        user,
        password,
    };

    const config = readConfig();
    writeConfig({ ...config, postgres: conn }).match(
        () => {},
        (e) => log.warn(`Failed to save postgres config: ${e.type}`),
    );

    return conn;
}

function resolveProvider(options: SetupOptions): Result<Provider | undefined, ProxyError> {
    if (options.provider === undefined) return ok(undefined);
    if (!isProvider(options.provider)) {
        return err(new ProxyError(`Unknown provider '${options.provider}'. Choose one of: ${PROVIDERS.join(", ")}.`));
    }
    return ok(options.provider);
}

function printNextSteps(options: SetupOptions, conn: PostgresConnection): void {
    const lines: string[] = [];
    lines.push(`Proxy: ${env.cliproxyBaseUrl}`);
    if (options.postgres && options.start) {
        lines.push(`Postgres: postgres://${conn.user}:***@${conn.host}:${conn.port}/${conn.database}`);
    } else if (options.postgres && !options.start) {
        lines.push("Postgres will start on next launch.");
    } else if (!options.postgres) {
        lines.push("Postgres provisioning skipped (--no-postgres).");
    }
    if (!options.start) {
        lines.push("Containers start automatically on next `inflexa` run.");
    }
    note(lines.join("\n"), "Next steps");
}

// --- proxy runtime ---------------------------------------------------------

const IMAGE = "eceasy/cli-proxy-api:latest";

/**
 * The image runs `./CLIProxyAPI` from WORKDIR /CLIProxyAPI (see upstream
 * Dockerfile); these are the in-container paths the binary reads.
 */
const CONTAINER_BINARY = "./CLIProxyAPI";
const CONTAINER_CONFIG_PATH = "/CLIProxyAPI/config.yaml";
const CONTAINER_AUTH_DIR = "/root/.cli-proxy-api";

type Provider = "gemini" | "openai" | "claude" | "qwen" | "iflow";

const PROVIDER_LOGIN_FLAG: Record<Provider, string> = {
    gemini: "--login",
    openai: "--codex-login",
    claude: "--claude-login",
    qwen: "--qwen-login",
    iflow: "--iflow-login",
};
const PROVIDER_LABEL: Record<Provider, string> = {
    gemini: "Gemini (Google)",
    openai: "OpenAI (Codex/GPT)",
    claude: "Claude (Anthropic)",
    qwen: "Qwen",
    iflow: "iFlow",
};
/**
 * OAuth-callback flows need their port published so the browser redirect to
 * localhost reaches the one-shot login container. Qwen uses a device flow and
 * needs no inbound port.
 */
const PROVIDER_CALLBACK_PORT: Record<Provider, number | null> = {
    gemini: 8085,
    openai: 1455,
    claude: 54545,
    qwen: null,
    iflow: 11451,
};
const PROVIDERS = Object.keys(PROVIDER_LOGIN_FLAG) as Provider[];

/**
 * Expected, user-actionable failures. Callers print `.message` and exit rather
 * than dumping a stack.
 */
export class ProxyError extends Error {}

function isProvider(value: string): value is Provider {
    return (PROVIDERS as string[]).includes(value);
}

// --- container plumbing ----------------------------------------------------
//
// The proxy's auth login flow runs as a throwaway `--rm` container, not a
// compose service (it's interactive and short-lived). Config writing and auth
// checking don't use containers at all.

function volumeArgs(rt: ContainerRuntime): string[] {
    return ["-v", rt.mountArg(env.cliproxyConfigPath, CONTAINER_CONFIG_PATH), "-v", rt.mountArg(env.cliproxyAuthDir, CONTAINER_AUTH_DIR)];
}

// --- config ----------------------------------------------------------------

async function writeProxyConfig(): Promise<{ created: boolean; apiKey?: string }> {
    await mkdir(dirname(env.cliproxyConfigPath), { recursive: true, mode: 0o700 });
    await mkdir(env.cliproxyAuthDir, { recursive: true, mode: 0o700 });

    if (await Bun.file(env.cliproxyConfigPath).exists()) return { created: false };

    const apiKey = generateApiKey();
    await writeFile(env.cliproxyConfigPath, proxyConfig(apiKey), { mode: 0o600 });
    return { created: true, apiKey };
}

/**
 * auth-dir is the in-container Linux path (mounted from env.cliproxyAuthDir), so
 * it is OS-safe regardless of the host.
 */
export function proxyConfig(apiKey: string): string {
    return `host: ""
port: ${env.cliproxyPort}
auth-dir: "${CONTAINER_AUTH_DIR}"
api-keys:
  - "${apiKey}"
debug: false
`;
}

/**
 * Client-facing key for calling the proxy — distinct from the provider
 * credentials the login flows write under auth-dir.
 */
export function generateApiKey(): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const rand = new Uint8Array(45);
    crypto.getRandomValues(rand);
    let key = "sk-";
    for (const b of rand) key += chars[b % chars.length];
    return key;
}

// --- authentication --------------------------------------------------------

async function isAuthenticated(): Promise<boolean> {
    return readdir(env.cliproxyAuthDir).then(
        (entries) => entries.some((name) => !name.startsWith(".")),
        () => false,
    );
}

/**
 * Run the proxy's OAuth flow in a throwaway container. Pipes stdout/stderr to
 * extract the auth URL (dropping `-t` — the `--no-browser` mode doesn't need a
 * PTY, it just prints a URL and waits for the HTTP callback on the published
 * port). The extracted URL is copied to the clipboard and shown in a clack
 * `note` box. stdin is still inherited (`-i`) so any interactive prompt the
 * container might issue still works.
 */
async function runProviderLogin(rt: ContainerRuntime, provider: Provider): Promise<void> {
    const port = PROVIDER_CALLBACK_PORT[provider];
    const publish = port === null ? [] : ["-p", `${port}:${port}`];
    // No `-t`: the `--no-browser` flow doesn't need a PTY. Dropping it lets us
    // pipe stdout/stderr to capture the auth URL without hanging.
    const args = ["run", "--rm", "-i", ...volumeArgs(rt), ...publish, IMAGE, CONTAINER_BINARY, PROVIDER_LOGIN_FLAG[provider], "--no-browser"];

    const s = clackSpinner();
    s.start(`Authenticating ${PROVIDER_LABEL[provider]}`);

    const proc = Bun.spawn({
        cmd: [rt.bin, ...args],
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
    });

    const urlPattern = /https?:\/\/[^\s"'<>]+/g;
    const sshPattern = /ssh\s+-[iL].*\d+/g;
    let authUrl: string | null = null;
    let sshCommand: string | null = null;
    let urlShown = false;

    async function scanStream(stream: ReadableStream<Uint8Array>): Promise<void> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                // Capture the first SSH tunnel command (for remote/SSH scenarios).
                if (!sshCommand) {
                    const sshMatch = line.match(sshPattern);
                    if (sshMatch) sshCommand = sshMatch[0];
                }

                const urls = line.match(urlPattern);
                if (!urls) continue;
                for (const url of urls) {
                    if (url.length > 40 && !url.includes("BuiltAt")) {
                        authUrl = url;
                    }
                }

                // Show the URL once, as soon as it's found, so the user can act
                // while the container waits for the OAuth callback.
                if (authUrl && !urlShown) {
                    urlShown = true;
                    s.stop(`${PROVIDER_LABEL[provider]} — open this URL in your browser`);
                    const { writeClipboard } = await import("../../lib/clipboard.ts");
                    await writeClipboard(authUrl);
                    // Print the URL as a plain line outside any box so it's
                    // selectable with a triple-click (note() wraps long URLs
                    // at the box border, breaking copy-paste).
                    console.log();
                    console.log(`  ${authUrl}`);
                    console.log();
                    log.info("Copied to clipboard.");
                    if (sshCommand) {
                        note(`${sshCommand}`, "Remote? Tunnel the callback port first");
                    }
                    s.start(`Waiting for ${PROVIDER_LABEL[provider]} callback`);
                }
            }
        }
    }

    const scanPromise = Promise.all([scanStream(proc.stdout), scanStream(proc.stderr)]);
    const code = await proc.exited;
    await scanPromise;

    if (code !== 0 && code !== null) {
        s.error(`${PROVIDER_LABEL[provider]} login failed (exit code ${code})`);
        log.warn("You can retry with `inflexa setup`.");
    } else {
        s.stop(`${PROVIDER_LABEL[provider]} authenticated`);
    }
}

/**
 * Provider chooser using @clack/prompts select. Returns the chosen provider,
 * or null to skip. A non-interactive terminal can't drive the prompt.
 */
async function chooseProvider(preselected: Provider | undefined): Promise<Provider | null> {
    if (preselected) return preselected;
    if (!process.stdin.isTTY) return null;

    const options = [...PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] })), { value: "_skip", label: "Skip for now" }];

    const chosen = await select("Authenticate a provider (opens a browser)", options);
    if (chosen === "_skip") return null;
    return chosen as Provider;
}

async function authenticate(rt: ContainerRuntime, preselected: Provider | undefined): Promise<boolean> {
    const chosen = await chooseProvider(preselected);
    if (chosen) await runProviderLogin(rt, chosen);
    return isAuthenticated();
}

// --- shared entry used by the TUI ------------------------------------------

/**
 * Make the proxy ready to serve the TUI: runtime up, config written,
 * authenticated, compose services running. Returns a {@link ProxyError} or
 * {@link ContainerRuntimeError} on the error channel with actionable guidance
 * when it can't proceed.
 */
export async function ensureProxyReady(): Promise<Result<void, ProxyError | ContainerRuntimeError>> {
    const rt = activeRuntime();
    const readyResult = await ensureReady(rt);
    if (readyResult.isErr()) return readyResult;

    try {
        await writeProxyConfig();
    } catch (cause) {
        return err(new ProxyError(`Failed to write proxy config: ${cause instanceof Error ? cause.message : String(cause)}`));
    }

    if (!(await isAuthenticated())) {
        if (!process.stdin.isTTY) {
            return err(new ProxyError("CLIProxyAPI isn't authenticated yet.\n  Run `inflexa setup` to sign in to a provider before starting the TUI."));
        }
        console.log("\n  CLIProxyAPI isn't authenticated yet — let's sign in.");
        try {
            if (!(await authenticate(rt, undefined))) {
                return err(new ProxyError("Authentication didn't complete.\n  Run `inflexa setup` to finish signing in, then try again."));
            }
        } catch (cause) {
            return err(new ProxyError(`Authentication failed: ${cause instanceof Error ? cause.message : String(cause)}`));
        }
    }

    // Compose up is idempotent — starts only containers that aren't running.
    // Generate the compose file if it doesn't exist yet (self-healing gate).
    const conn = resolvePostgresConfig();
    const composeWriteErr = writeComposeFile(conn).match(
        () => null,
        (e) => e,
    );
    if (composeWriteErr) {
        return err(new ProxyError(`Failed to generate compose file: ${composeWriteErr.message}`));
    }

    // Pull missing images with streaming progress before compose up. compose up -d
    // would implicitly pull via capture(), but that buffers silently and makes the
    // TUI launch appear to hang on a fresh install.
    const pullResult = await composePullIfMissing(rt);
    if (pullResult.isErr()) {
        return err(new ProxyError(pullResult.error.message));
    }

    const upResult = await composeUp(rt);
    if (upResult.isErr()) {
        return err(new ProxyError(`Failed to start containers: ${upResult.error.message}`));
    }

    return ok(undefined);
}

/**
 * The exit-on-error variant of {@link ensureProxyReady} for the TUI launch path.
 */
export async function ensureProxyReadyOrExit(): Promise<void> {
    const result = await ensureProxyReady();
    if (result.isErr()) {
        console.error(`\n  ${result.error.message}\n`);
        process.exit(1);
    }
}
