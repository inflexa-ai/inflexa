import { readdir } from "node:fs/promises";

import { intro, outro, log, note, spinner as clackSpinner } from "@clack/prompts";
import { type Result, ok, err } from "neverthrow";
import { ensureRuntime, readConfig, resolvePostgresConfig, selectedRuntime, writeConfig, type ConfigError } from "../../lib/config.ts";
import { firstReadyRuntime, runtimeIds, runtimes, ContainerRuntimeError, type ContainerRuntime } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { select, promptText } from "../../lib/cli.ts";
import { detectedMachine, resolveHarnessConfig } from "../harness/config.ts";
import { type PostgresConnection } from "./postgres_types.ts";
import { writeComposeFile, composeUp, composePull, composePullIfMissing, composeAvailable, type ConnectionMode } from "./compose.ts";
import { formatInfraStateError, writeProxyConfig } from "./proxy_config.ts";

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
    /** Preselected connection mode from `--connection` (`cliproxy` | `direct`); overrides the prompt. */
    connection?: string;
    auth: boolean;
    start: boolean;
    force: boolean;
    /** Whether to provision Postgres (default true; `--no-postgres` sets false). */
    postgres: boolean;
    /** Preselected embedding mode from `--embeddings`; overrides the interactive prompt. */
    embeddings?: "local" | "api-key" | "off";
    /** Explicit comma-separated reference ids parsed at the command boundary. */
    refs?: readonly string[];
    /** Explicit consent for selected reference downloads. */
    yes?: boolean;
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

    const connectionFlag = parseConnectionMode(options.connection).match(
        (m) => m,
        (e) => {
            console.error(`\n  ${e.message}\n`);
            process.exitCode = 1;
            return null as ConnectionMode | undefined | null;
        },
    );
    if (connectionFlag === null) return;

    // Setup treats the runtime selection as a preference, not a gate: the selected
    // runtime (when there is one) is probed first, then the other supported
    // runtimes, and the first ready one wins ("Docker configured but stopped,
    // Podman running" self-heals here instead of erroring). Outside setup an
    // explicit selection is a hard gate (see ensureRuntime) — this deliberate
    // re-provisioning entry point is the ONE place a dead selection may be
    // switched away from.
    const selected = selectedRuntime();
    const candidates = selected ? [selected, ...runtimeIds.filter((id) => id !== selected.id).map((id) => runtimes[id])] : runtimeIds.map((id) => runtimes[id]);
    const readyResult = await firstReadyRuntime(candidates);
    if (readyResult.isErr()) {
        console.error(`\n  ${readyResult.error.message}\n`);
        process.exitCode = 1;
        return;
    }
    const rt = readyResult.value;

    intro("inflexa setup");

    if (rt.id !== selected?.id) {
        log.info(
            selected
                ? `${selected.label} isn't ready — continuing with ${rt.label} and saving it as the container runtime.`
                : `Using ${rt.label} as the container runtime (saved to settings).`,
        );
        const writeError = writeConfig({ ...readConfig(), runtime: rt.id }).match(
            () => null,
            (e) => e,
        );
        if (writeError) {
            // Later steps (postgres provisioning, the sandbox pull) re-read config
            // for the runtime, so an unpersisted switch would split this run across
            // two runtimes — abort instead of provisioning an incoherent stack.
            log.error(`Could not save the runtime selection: ${writeError.type}`);
            process.exitCode = 1;
            return;
        }
    }

    try {
        const mode = await chooseConnectionMode(connectionFlag);

        if (mode === "cliproxy") {
            // --- proxy config ---
            const writeResult = await writeProxyConfig();
            if (writeResult.isErr()) {
                // Known filesystem-state faults (e.g. a directory manufactured at the config path) get a
                // specific diagnosis + remediation here, before the outer catch — which stays a backstop
                // for genuinely unknown throws only.
                log.error(formatInfraStateError(writeResult.error));
                process.exitCode = 1;
                return;
            }
            const proxyConfigOutcome = writeResult.value;
            if (proxyConfigOutcome.created) {
                log.success(`Wrote proxy config at ${env.cliproxyConfigPath}`);
                note(proxyConfigOutcome.apiKey, "Client API key (use this to call the proxy)");
            } else {
                log.info(`Proxy config exists at ${env.cliproxyConfigPath}`);
            }

            // --- provider auth ---
            // authenticate() records the connection provider fact on a successful login (see
            // recordCliproxyProvider), so the cliproxy path always leaves `models.connection` naming
            // the authenticated vendor.
            if (options.auth) {
                if (provider === undefined && (await isAuthenticated())) {
                    log.info("Already authenticated — use `--provider <name>` to add or switch.");
                } else {
                    const authed = await authenticate(rt, provider);
                    if (!authed) log.warn("No provider authenticated yet — re-run `inflexa setup` to sign in.");
                }
            }
        } else {
            // --- direct connection ---
            // The endpoint and provider are collected interactively (there are no non-interactive
            // flags for them), so a scripted `--connection direct` cannot proceed — fail with a clear
            // instruction rather than the shared prompt's generic "stdin is not interactive" bail-out.
            if (!process.stdin.isTTY) {
                log.error(
                    "Direct-connection setup needs an interactive terminal to collect the endpoint and provider.\n  Re-run `inflexa setup --connection direct` in an interactive shell.",
                );
                process.exitCode = 1;
                return;
            }
            const direct = await promptDirectConnection();
            const writeErr = writeDirectConnection(direct).match(
                () => null,
                (e) => e,
            );
            if (writeErr) {
                log.error(`Failed to save the model connection: ${writeErr.type}`);
                process.exitCode = 1;
                return;
            }
            log.success("Saved the direct model connection.");
            note(
                `Export your provider API key before starting a chat:\n\n  export ${MODEL_API_KEY_VAR}=<your-key>\n\nThe key is read from the environment only — it is never written to config.`,
                "Model API key",
            );
        }

        // --- postgres config ---
        // Postgres is provisioned in BOTH modes; only the compose file's service set differs (the mode
        // drops or keeps the proxy service — see generateComposeFile).
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
            const composeWriteErr = writeComposeFile(pgConn, mode).match(
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
                const upResult = await composeUp(rt, mode);
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

        // --- analysis resource allowance ---
        // Collects the machine budget for the harness's resource policy — the
        // total share of this host analyses may use; per-step ceilings are
        // derived from it, and enforcement is the harness's contract. Non-TTY
        // shells skip the prompt — the resolved default (half the detected
        // machine) applies.
        await promptResourceConfig();

        // --- embeddings ---
        // Runs after auth + postgres, before "Setup complete". The interactive
        // prompt (clack select) offers local / api-key / off; a non-TTY shell or
        // a preselected `--embeddings` mode skips the prompt. See
        // modules/embedding/setup.ts.
        const { runEmbeddingSetup } = await import("../embedding/setup.ts");
        const embedResult = await runEmbeddingSetup(process.stdin.isTTY, options.embeddings);
        if (embedResult.isErr()) {
            log.error(`Embedding setup: ${embedResult.error.message}`);
            process.exitCode = 1;
            return;
        }

        // --- reference data ---
        // The setup offer and `inflexa refs download` share one handler. Creating the public
        // store/user namespace is deliberate here; no passive runtime path creates it.
        const { runReferenceSetup } = await import("../refs/commands.ts");
        const refsResult = await runReferenceSetup({
            interactive: process.stdin.isTTY,
            ...(options.refs === undefined ? {} : { ids: options.refs }),
            ...(options.yes === undefined ? {} : { yes: options.yes }),
        });
        if (refsResult.isErr()) {
            log.error(`Reference-data setup: ${refsResult.error.message}`);
            process.exitCode = 1;
            return;
        }

        // --- sandbox image ---
        // Provision the sandbox image through the SAME handler as
        // `inflexa sandbox pull` (design: one dogfooded path). A pull failure warns
        // and continues — the image is an offer here, not a hard prerequisite
        // (`inflexa profile` pulls it on demand if still missing).
        await runSandboxImageSetup();

        printNextSteps(options, pgConn, mode);
        outro("Setup complete");
    } catch (error) {
        log.error(`Setup failed unexpectedly: ${error}`);
        process.exitCode = 1;
    }
}

/**
 * Provision the sandbox image as part of `inflexa setup`. Reuses the `sandboxPull`
 * handler (never a second fetch path); the user picks a variant (`python` /
 * `python-r`) and `docker pull` resolves the host arch from the multi-arch
 * manifest. The image can be multiple GB, so pulling is gated on explicit consent:
 *   - Interactive: hand off to `sandboxPull` so it prompts the variant, confirms
 *     before the transfer, and streams progress.
 *   - Non-interactive: do NOT auto-download — a headless run must never silently
 *     pull GBs. Print a hint to the explicit command and continue.
 * Every branch is non-fatal (decline, failure): the image is an offer here, not a
 * prerequisite — `inflexa profile` pulls it on demand if still missing.
 */
async function runSandboxImageSetup(): Promise<void> {
    // Headless setup never auto-downloads (the image is multi-GB); point at the
    // explicit command and continue so the rest of setup still completes.
    if (!process.stdin.isTTY) {
        note(
            "Skipping the sandbox image on a non-interactive terminal.\nRun `inflexa sandbox pull <python|python-r> --yes` to install it later.",
            "Sandbox image",
        );
        return;
    }

    // sandboxPull owns the variant prompt + size confirmation when left interactive.
    const { sandboxPull } = await import("../libs/pull.ts");
    (await sandboxPull()).match(
        (outcome) => {
            if (outcome.type === "up_to_date") log.success(`Sandbox image already installed (${outcome.image}).`);
            else if (outcome.type === "pulled") log.success(`Sandbox image installed (${outcome.image}).`);
            else if (outcome.type === "declined") log.info("Sandbox image skipped. Run `inflexa sandbox pull` later to install it.");
        },
        (error) =>
            error.type === "no_variant"
                ? log.info(error.message)
                : log.warn(`Sandbox image install failed: ${error.message}\n  You can retry later with \`inflexa sandbox pull\`.`),
    );
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

/**
 * Prompt for the machine allowance — the total share of this host analyses may
 * use — and persist it as absolute values under `harness.resourceLimits.budget`.
 * One question: everything else about resource limits (per-step ceilings,
 * ephemeral sizing) is derived from the allowance or expert config, not setup
 * material. The default share reflects the currently-resolved budget (half the
 * machine on a fresh config), so re-running setup shows what already applies.
 * Non-interactive terminals skip the prompt — the same resolved defaults apply
 * at run time without a config entry.
 */
async function promptResourceConfig(): Promise<void> {
    if (!process.stdin.isTTY) return;

    const machine = detectedMachine();
    const resolved = resolveHarnessConfig();
    const currentPct = Math.min(100, Math.max(1, Math.round((resolved.resourcePolicy.budget.cpu / machine.cpu) * 100)));
    log.message(`Configure the analysis resource allowance — detected ${machine.cpu} cores / ${machine.memoryGb} GB`);

    const sharePct = (v: string): string | undefined => {
        if (v.trim() === "") return undefined;
        const n = Number(v.trim());
        if (isNaN(n) || n <= 0 || n > 100) return "Must be a percentage between 1 and 100.";
        return undefined;
    };
    const answer = await promptText("Max share of this machine analyses may use in total (%)", {
        defaultValue: String(currentPct),
        placeholder: String(currentPct),
        validate: sharePct,
    }).catch(() => String(currentPct));
    const parsed = Number(answer);
    const pct = parsed > 0 && parsed <= 100 ? parsed : currentPct;
    const budget = {
        cpu: Math.max(1, Math.floor((machine.cpu * pct) / 100)),
        memoryGb: Math.max(1, Math.floor((machine.memoryGb * pct) / 100)),
    };
    log.message(`Analyses may use up to ${budget.cpu} cores / ${budget.memoryGb} GB in total`);

    const config = readConfig();
    // `config.harness` is deliberately `unknown` in lib/config.ts (the harness
    // module owns its validation) — spread it as a plain record so the fields
    // this prompt does not manage (model, bioKeys, per-step overrides, …)
    // survive the rewrite.
    const harness = (config.harness ?? {}) as Record<string, unknown>;
    const resourceLimits = (harness.resourceLimits ?? {}) as Record<string, unknown>;
    writeConfig({
        ...config,
        harness: {
            ...harness,
            resourceLimits: { ...resourceLimits, budget },
        },
    }).match(
        () => {},
        (e) => log.warn(`Failed to save resource limits: ${e.type}`),
    );
}

function resolveProvider(options: SetupOptions): Result<Provider | undefined, ProxyError> {
    if (options.provider === undefined) return ok(undefined);
    if (!isProvider(options.provider)) {
        return err(new ProxyError(`Unknown provider '${options.provider}'. Choose one of: ${PROVIDERS.join(", ")}.`));
    }
    return ok(options.provider);
}

function printNextSteps(options: SetupOptions, conn: PostgresConnection, mode: ConnectionMode): void {
    const lines: string[] = [];
    if (mode === "cliproxy") {
        lines.push(`Proxy: ${env.cliproxyBaseUrl}`);
    } else {
        lines.push(`Model connection: direct — export ${MODEL_API_KEY_VAR} with your provider key.`);
    }
    if (options.postgres && options.start) {
        lines.push(`Postgres: postgres://${conn.user}:***@${conn.host}:${conn.port}/${conn.database}`);
    } else if (options.postgres && !options.start) {
        lines.push("Postgres will start on next launch.");
    } else if (!options.postgres) {
        lines.push("Postgres provisioning skipped (--no-postgres).");
    }
    lines.push("Embeddings: run `inflexa setup --embeddings local` (in-process) or `--embeddings api-key`.");
    if (!options.start) {
        lines.push("Containers start automatically on next `inflexa` run.");
    }
    note(lines.join("\n"), "Next steps");
}

// --- connection mode -------------------------------------------------------
//
// The connection choice decides the whole flow: `cliproxy` provisions the managed proxy (its config +
// provider OAuth) and records the provider from the login; `direct` writes the user's endpoint and
// provider to `models.connection`, skips all proxy provisioning, and points at INFLEXA_MODEL_API_KEY.
// Postgres provisioning is mode-independent.

/**
 * The direct-mode secret's environment variable. Mirrors lib/env.ts's `modelApiKeyVar` — the sole
 * `process.env` reader, which does not export the name — because setup only PRINTS it (never reads it),
 * so the literal is duplicated rather than widening env.ts's surface for a display string.
 */
const MODEL_API_KEY_VAR = "INFLEXA_MODEL_API_KEY";

/**
 * Validate the `--connection` flag value. `undefined` (flag absent) is OK — the mode is then chosen
 * interactively, or defaults to `cliproxy` on a non-TTY (today's scripted-setup behavior). Any other
 * value is a user-actionable error.
 */
export function parseConnectionMode(value: string | undefined): Result<ConnectionMode | undefined, ProxyError> {
    if (value === undefined) return ok(undefined);
    if (value !== "cliproxy" && value !== "direct") {
        return err(new ProxyError(`Unknown connection '${value}'. Choose one of: cliproxy, direct.`));
    }
    return ok(value);
}

/**
 * Resolve the connection mode: the pre-validated `--connection` value when given, else an interactive
 * select, else (non-TTY, no flag) the `cliproxy` default so a scripted setup keeps today's behavior.
 */
async function chooseConnectionMode(preselected: ConnectionMode | undefined): Promise<ConnectionMode> {
    if (preselected) return preselected;
    if (!process.stdin.isTTY) return "cliproxy";
    const chosen = await select("How should inflexa reach models?", [
        { value: "cliproxy", label: "Managed local proxy (CLIProxyAPI) — default" },
        { value: "direct", label: "Direct endpoint (your own provider)" },
    ]);
    // The select's value domain is exactly ConnectionMode's two literals, so the cast is total.
    return chosen as ConnectionMode;
}

/**
 * Collect a direct connection interactively: the endpoint URL (must parse as a URL), the provider slug
 * (open vocabulary, lowercased, non-empty), and an optional wire protocol. "Infer from provider" leaves
 * the protocol unset so `resolveModelConnection` (modules/harness/config.ts) implies it from the
 * provider.
 *
 * The endpoint prompt names the `/v1`-terminated protocol root (e.g. `https://api.anthropic.com/v1`)
 * because that one configured value feeds BOTH the chat wire path (anthropic `{baseURL}/messages`,
 * openai-compatible `{baseURL}/chat/completions`) and the model listing (`{baseURL}/models`). A bare
 * root without `/v1` would 404 the chat path, so steering users to the terminated form here prevents a
 * connection that can list models but never chat.
 */
async function promptDirectConnection(): Promise<DirectConnectionInput> {
    const baseURL = await promptText("Model endpoint URL — the /v1-terminated root (e.g. https://api.openai.com/v1 or https://api.anthropic.com/v1)", {
        placeholder: "https://api.openai.com/v1",
        validate: (v) => {
            const s = v.trim();
            if (s === "") return "Enter the endpoint URL.";
            if (!URL.canParse(s)) return "Must be a valid URL, including the scheme (e.g. https://…).";
            return undefined;
        },
    });
    const provider = await promptText("Provider slug (e.g. openai, anthropic, google)", {
        validate: (v) => (v.trim() === "" ? "Enter a provider slug." : undefined),
    });
    const protocolChoice = await select("Wire protocol", [
        { value: "infer", label: "Infer from provider (default)" },
        { value: "anthropic", label: "Anthropic" },
        { value: "openai-compatible", label: "OpenAI-compatible" },
    ]);
    return {
        provider: provider.trim().toLowerCase(),
        baseURL: baseURL.trim(),
        // "infer" leaves protocol unset; the two explicit values are exactly the schema's wire kinds.
        ...(protocolChoice !== "infer" && { protocol: protocolChoice as "anthropic" | "openai-compatible" }),
    };
}

/** A direct connection's user-supplied facts, written verbatim to `models.connection`. */
type DirectConnectionInput = {
    provider: string;
    baseURL: string;
    protocol?: "anthropic" | "openai-compatible";
};

/**
 * Persist a direct-mode model connection. Spread-preserving: keeps every other config key and every
 * other key inside the `models` block (e.g. the `agents` overrides), rewriting only `connection`. The API
 * key is NEVER written here — it comes from {@link MODEL_API_KEY_VAR} at provider construction.
 */
export function writeDirectConnection(input: DirectConnectionInput): Result<void, ConfigError> {
    const config = readConfig();
    // `config.models` is `unknown` in lib/config.ts (validated downstream by resolveModelConnection),
    // so spread it as a plain record to preserve sibling keys this write does not manage.
    const models = (config.models ?? {}) as Record<string, unknown>;
    const connection = {
        mode: "direct",
        provider: input.provider,
        baseURL: input.baseURL,
        // Omit `protocol` when absent so the resolver implies it from the provider.
        ...(input.protocol !== undefined && { protocol: input.protocol }),
    };
    return writeConfig({ ...config, models: { ...models, connection } });
}

/**
 * Account-kind → provider-slug map. It lives ONLY here because the account kind is a KNOWN FACT at
 * login time: setup drove exactly this provider's OAuth flow, so it names the vendor directly. That is
 * why recording it here is legitimate where deriving a provider from a model id is not — this is the
 * configured fact, captured at its source, not a guess reverse-engineered from a served model id, which
 * would fabricate provenance.
 */
const PROVIDER_SLUG: Record<Provider, string> = {
    claude: "anthropic",
    openai: "openai",
    gemini: "google",
    qwen: "qwen",
    iflow: "iflow",
};

/**
 * Record the cliproxy connection's provider slug from the account kind just authenticated (see
 * {@link PROVIDER_SLUG}). Re-authenticating a different account kind rewrites the slug. Spread-preserving
 * like {@link writeDirectConnection}. Returns the write Result so the caller consumes it (a failure here
 * is a warning, not a setup-aborting error — the login itself succeeded).
 */
export function recordCliproxyProvider(kind: Provider): Result<void, ConfigError> {
    const config = readConfig();
    // See writeDirectConnection: `config.models` is `unknown`, spread as a record to keep siblings.
    const models = (config.models ?? {}) as Record<string, unknown>;
    return writeConfig({ ...config, models: { ...models, connection: { mode: "cliproxy", provider: PROVIDER_SLUG[kind] } } });
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
 * container might issue still works. Returns whether the login succeeded (exit 0/null) so the caller
 * records the provider fact only on a real success, never when the flow errored out.
 */
async function runProviderLogin(rt: ContainerRuntime, provider: Provider): Promise<boolean> {
    // The login container bind-mounts the proxy config file (file-typed) and the auth dir
    // (directory-typed) via volumeArgs. Provision those sources through the shared seam BEFORE the engine
    // runs, structurally here rather than trusting each caller to have done it: an absent config path
    // would otherwise be manufactured by the engine as a directory, wedging every later write to it with
    // EISDIR. writeProxyConfig heals an empty manufactured directory, writes the config when absent,
    // ensures the auth dir (0700), and refuses a non-empty occupant — exactly the two mounts this
    // container needs, and no more (it does not touch the Postgres data dir). Idempotent, so a caller that
    // already provisioned pays only a re-stat.
    const provisioned = await writeProxyConfig();
    if (provisioned.isErr()) {
        // Known filesystem-state fault (e.g. a directory manufactured at the config path): surface the
        // diagnosis + remediation, not a raw errno. No spinner has started yet, so this is the only output.
        log.error(formatInfraStateError(provisioned.error));
        return false;
    }

    const port = PROVIDER_CALLBACK_PORT[provider];
    // Loopback-only: publish the OAuth callback port where only this host can reach it, never the LAN. A remote/SSH
    // login still works — the SSH local-forward hinted below targets localhost on this host, which is the loopback bind.
    const publish = port === null ? [] : ["-p", `127.0.0.1:${port}:${port}`];
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
        return false;
    }
    s.stop(`${PROVIDER_LABEL[provider]} authenticated`);
    return true;
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
    if (chosen) {
        const loggedIn = await runProviderLogin(rt, chosen);
        // Record the connection provider fact from the account kind on a successful login. This runs
        // for both the setup flow and the TUI-launch fallback login (ensureProxyReady) — every login
        // rewrites the slug. A write failure is non-fatal: the OAuth login already succeeded.
        if (loggedIn) {
            recordCliproxyProvider(chosen).match(
                () => {},
                (e) => log.warn(`Could not record the model connection provider: ${e.type}`),
            );
        }
    }
    return isAuthenticated();
}

// --- shared entry used by the TUI ------------------------------------------

/**
 * Make the chat backend's local prerequisites ready before the TUI takes the
 * terminal. The mode-INDEPENDENT phases always run — the container runtime, the
 * Postgres compose stack, and the embedder readiness gate — because they are the
 * harness runtime's prerequisites regardless of where chat traffic goes. The
 * proxy-SPECIFIC phases (writing the proxy config, provider OAuth) run only in
 * `cliproxy` mode: a `direct` connection reaches its own endpoint with
 * `INFLEXA_MODEL_API_KEY`, so the proxy is neither configured, authenticated, nor
 * required for chat. Returns a
 * {@link ProxyError} or {@link ContainerRuntimeError} on the error channel with
 * actionable guidance when it can't proceed.
 */
export async function ensureProxyReady(mode: "cliproxy" | "direct"): Promise<Result<void, ProxyError | ContainerRuntimeError>> {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err(rtResult.error);
    const rt = rtResult.value;

    // Proxy config + provider OAuth are only meaningful when chat targets the managed
    // proxy. A direct connection has neither, so both are skipped — the Postgres/compose
    // and embedder steps below still run as mode-independent prerequisites.
    if (mode === "cliproxy") {
        const writeResult = await writeProxyConfig();
        if (writeResult.isErr()) {
            // Known filesystem-state faults surface with their diagnosis + remediation naming the path,
            // not a raw errno — the launch gate must tell the user exactly how to unwedge.
            return err(new ProxyError(formatInfraStateError(writeResult.error)));
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
    }

    // Compose up is idempotent — starts only containers that aren't running. Always regenerate the
    // compose file for the resolved mode (authoritative regeneration point): a mode switch since the
    // last launch rewrites it coherently — proxy service dropped for direct, present for cliproxy.
    const conn = resolvePostgresConfig();
    const composeWriteErr = writeComposeFile(conn, mode).match(
        () => null,
        (e) => e,
    );
    if (composeWriteErr) {
        return err(new ProxyError(`Failed to generate compose file: ${composeWriteErr.message}`));
    }

    // Pull missing images with streaming progress before compose up. compose up -d
    // would implicitly pull via capture(), but that buffers silently and makes the
    // TUI launch appear to hang on a fresh install.
    const pullResult = await composePullIfMissing(rt, mode);
    if (pullResult.isErr()) {
        return err(new ProxyError(pullResult.error.message));
    }

    const upResult = await composeUp(rt, mode);
    if (upResult.isErr()) {
        return err(new ProxyError(`Failed to start containers: ${upResult.error.message}`));
    }

    // Embedding readiness gate: if the user previously opted into local mode,
    // ensure the GGUF is still present. We do NOT run the interactive setup
    // prompt here (that belongs to `inflexa setup`) — a missing model after a
    // prior opt-in surfaces as an actionable error.
    const { ensureEmbedderReady } = await import("../embedding/setup.ts");
    const embedResult = await ensureEmbedderReady();
    if (embedResult.isErr()) {
        return err(new ProxyError(`Embeddings: ${embedResult.error.message}`));
    }

    return ok(undefined);
}

/**
 * The exit-on-error variant of {@link ensureProxyReady} for the TUI launch path.
 */
export async function ensureProxyReadyOrExit(mode: "cliproxy" | "direct"): Promise<void> {
    const result = await ensureProxyReady(mode);
    if (result.isErr()) {
        console.error(`\n  ${result.error.message}\n`);
        process.exit(1);
    }
}
