import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { intro, outro, log, note, spinner as clackSpinner } from "@clack/prompts";
import { type Result, ok, err } from "neverthrow";
import { z } from "zod";
import { ensureRuntime, readConfig, resolvePostgresConfig, selectedRuntime, writeConfig, type ConfigError, type ModelAuthConfig } from "../../lib/config.ts";
import { firstReadyRuntime, runtimeIds, runtimes, ContainerRuntimeError, type ContainerRuntime } from "../../lib/container.ts";
import {
    anthropicAuthTokenSet,
    detectProviderEnv,
    env,
    isReservedPostgresPort,
    providerApiKeyVar,
    resolveModelApiKey,
    type ProviderEnvSnapshot,
} from "../../lib/env.ts";
import { createCredentialSource, credentialErrorMessage, type Credential, type CredentialScheme } from "../../lib/credential.ts";
import { select, promptText, confirm } from "../../lib/cli.ts";
import {
    AGENT_NAMES,
    detectedMachine,
    resolveHarnessConfig,
    resolveModelConnection,
    writeAgentModel,
    type AgentName,
    type ResolvedModelConnection,
} from "../harness/config.ts";
import {
    checkModelAccess,
    conventionalDefaultModel,
    isProxyCooldown,
    listModelCandidates,
    modelMatchesProvider,
    rankModelCandidates,
    readApiKey,
    resolveModelId,
    type ChatSetupError,
    type ModelAccess,
} from "../proxy/models.ts";
import { DEFAULT_DATABASE, DEFAULT_HOST, DEFAULT_PASSWORD, DEFAULT_USER, type PostgresConnection } from "./postgres_types.ts";
import {
    writeComposeFile,
    composeUp,
    composePull,
    composePullIfMissing,
    composeAvailable,
    composeProxyRunning,
    composeRestartProxy,
    PROXY_IMAGE,
    type ConnectionMode,
} from "./compose.ts";
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

    // Local embeddings need no container runtime — the llama-server sidecar is a
    // plain subprocess, not a compose service — and the bge-small model ships as a
    // build-time embedded asset. So a preselected `--embeddings` mode is configured
    // ahead of the runtime gate below, so an air-gapped / egress-restricted
    // `inflexa setup --embeddings local` still durably configures embeddings on a
    // host with no ready Docker/Podman; the gate that follows governs only the
    // container stack, which genuinely needs a runtime. The interactive
    // no-preselection flow keeps its embedding question in its spec-bound position
    // after provider auth (see the in-flow step below), so this fires ONLY for an
    // explicit `--embeddings` value.
    if (options.embeddings !== undefined) {
        const { runEmbeddingSetup } = await import("../embedding/setup.ts");
        const embedResult = await runEmbeddingSetup(process.stdin.isTTY, options.embeddings);
        if (embedResult.isErr()) {
            log.error(`Embedding setup: ${embedResult.error.message}`);
            process.exitCode = 1;
            return;
        }
    }

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
                    // "exists", not "authenticated": a dead refresh token is statically invisible
                    // (nothing in the credential file records it), so this branch cannot promise the
                    // credential works — it can only say one is present and name the way to re-login.
                    log.info("A provider credential exists. If chats fail to authenticate, re-run with `--provider <name>` to sign in again.");
                } else {
                    const authed = await authenticate(rt, provider);
                    if (!authed) {
                        log.warn("No provider authenticated yet — re-run `inflexa setup` to sign in.");
                    } else {
                        // A proxy left running by an earlier launch keeps serving whatever credentials
                        // it loaded at boot — host writes to the mounted auth dir never reach its file
                        // watcher, and the compose-up below is idempotent — so without a bounce the
                        // sign-in that just completed stays invisible to it and chats keep failing
                        // auth. Only a currently-running container needs this; a stopped or
                        // not-yet-created one reads the auth dir when it next starts. An unanswerable
                        // engine skips the bounce rather than failing a setup that otherwise
                        // succeeded — the launch-gate probe still adjudicates the credential live.
                        const running = (await composeProxyRunning(rt)).unwrapOr(false);
                        if (running) {
                            const restarted = await composeRestartProxy(rt);
                            if (restarted.isErr()) {
                                log.error(
                                    `The sign-in succeeded, but the running proxy could not be restarted to load it: ${restarted.error.message}\n  Restart the stack (\`inflexa down\`, then launch again) before chatting.`,
                                );
                                process.exitCode = 1;
                                return;
                            }
                            log.info("Restarted the proxy so it serves the fresh sign-in.");
                        }
                    }
                }
            }
        } else {
            // --- direct connection ---
            // Setup can ADOPT an already-configured ecosystem env (ANTHROPIC_*/OPENAI_*) — a machine set up
            // for Claude Code / the SDKs need not re-type the endpoint or re-export the key. The detection
            // is a one-time setup read (never a runtime binding); only the non-secret fields are copied.
            const snap = detectProviderEnv();
            const adoptable = detectedAdoptable(snap);
            // Detected BEFORE the endpoint prompt (a cheap read-only probe): a credential-helper setup
            // often carries the gateway ENDPOINT too (the settings `env.ANTHROPIC_BASE_URL`, or a
            // key-less shell export), and the endpoint question comes first — so the detection must
            // already be in hand for promptDirectConnection to offer that URL as a pre-fill.
            const detection = detectCredentialHelper();

            let direct: DirectConnectionInput;
            // The credential probe's conclusion, when the credential-source offer ran one: carries the
            // /models ids and minted token the model step below reuses (no second mint, no second listing).
            let credentialProbe: CredentialProbeResult | null = null;
            if (process.stdin.isTTY) {
                direct = await promptDirectConnection(snap, adoptable, detection);
                // A detected credential-helper setup can supply a refreshing token (a helper command or an
                // env bearer) in place of a static key. Offer it opt-in — the command/scheme need
                // confirmation, and an org-managed helper must never be auto-executed. Only for an
                // anthropic-wire connection: the detection signals (Claude Code's `apiKeyHelper`,
                // `ANTHROPIC_AUTH_TOKEN`) are Anthropic-specific, so minting one to probe against an
                // unrelated openai-compatible endpoint would be a confusing, wrong offer.
                if (effectiveProtocol(direct) === "anthropic" && credentialHelperDetected(detection)) {
                    const offered = await offerCredentialSource(direct, detection);
                    if (offered !== null) {
                        direct = { ...direct, auth: offered.auth };
                        credentialProbe = offered.probe;
                    }
                }
            } else if (adoptable.length > 0) {
                // Non-interactive self-configure: adopt the detected env with no prompts, applying the
                // deterministic anthropic-before-openai precedence so a scripted run is reproducible.
                direct = adoptedConnection(adoptable[0]!, snap);
                log.info(`Adopting the detected ${direct.provider} environment (${direct.baseURL}).`);
            } else {
                // No TTY and nothing to adopt: the endpoint/provider have no non-interactive flags, so a
                // scripted `--connection direct` cannot proceed — fail with a clear instruction rather than
                // the shared prompt's generic "stdin is not interactive" bail-out.
                log.error(
                    "Direct-connection setup needs an interactive terminal to collect the endpoint and provider,\n" +
                        "  or a detected ANTHROPIC_*/OPENAI_* environment to adopt.\n" +
                        "  Re-run `inflexa setup --connection direct` in an interactive shell.",
                );
                process.exitCode = 1;
                return;
            }

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
            if (direct.auth !== undefined) {
                // A configured credential source supersedes the static key entirely: tell the user what is
                // stored (name/command + scheme, never the token).
                note(
                    direct.auth.kind === "command"
                        ? `Minting the model token with a credential command, sent as ${direct.auth.scheme}.\n` +
                              "Only the command and scheme are stored — the token value is never written to config."
                        : `Reading the model token from ${direct.auth.var}, sent as ${direct.auth.scheme}.\n` +
                              "Only the variable name and scheme are stored — the token value is never written to config.",
                    "Model credential source",
                );
            } else {
                // Tailor the key guidance to what is actually resolvable now: an adopted ecosystem env already
                // carries the key (ANTHROPIC_API_KEY/OPENAI_API_KEY), so tell the user it is being read rather
                // than instruct a redundant re-export. `resolveModelApiKey` reads the env only — nothing is copied.
                const resolvedVar = resolveModelApiKey(direct.provider) ? providerApiKeyVar(direct.provider) : undefined;
                note(
                    resolvedVar !== undefined && resolvedVar !== MODEL_API_KEY_VAR
                        ? `Using ${resolvedVar} from your environment for the model key.\n` +
                              `Override it any time by exporting ${MODEL_API_KEY_VAR}. The key is read from the environment only — never written to config.\n\n` +
                              `For a short-lived token instead (${ANTHROPIC_AUTH_TOKEN_VAR} bearer, or a credential helper), re-run setup to configure a credential source.\n` +
                              "Bedrock/Vertex are not adopted (no direct signer)."
                        : `Export your provider API key before starting a chat:\n\n  export ${MODEL_API_KEY_VAR}=<your-key>\n` +
                              `  (or the provider-conventional ${providerApiKeyVar(direct.provider)})\n\n` +
                              "The key is read from the environment only — it is never written to config.\n\n" +
                              `For a short-lived token instead (${ANTHROPIC_AUTH_TOKEN_VAR} bearer, or a credential helper), re-run setup to configure a credential source.\n` +
                              "Bedrock/Vertex are not adopted (no direct signer).",
                    "Model API key",
                );
            }

            // Direct mode has no model auto-resolve: without an explicit id boot fails `model_required`,
            // so the interactive flow finishes the job here. A non-TTY run writes nothing — boot's
            // actionable failure remains the documented contract.
            if (process.stdin.isTTY) {
                await collectDirectModelAtSetup(direct, credentialProbe);
            }
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

        // --- default chat model ---
        // Cliproxy only, and only after the compose step above started the proxy, so the live `/models`
        // list and the accessibility sweep can answer. Nothing here WAITS on the proxy's port bind (the
        // readiness wait above is Postgres's own) — a proxy still binding just makes the step skip
        // gracefully, which is fine because it is optional and must never fail setup. Offers a
        // preselected Auto default plus the account's accessible models.
        await runDefaultModelSetup(mode);

        // --- analysis resource allowance ---
        // Collects the machine budget for the harness's resource policy — the
        // total share of this host analyses may use; per-step ceilings are
        // derived from it, and enforcement is the harness's contract. Non-TTY
        // shells skip the prompt — the resolved default (half the detected
        // machine) applies.
        await promptResourceConfig();

        // --- embeddings ---
        // The spec-bound position for the INTERACTIVE embedding question — after auth
        // + postgres, before "Setup complete". The clack select offers
        // local / api-key / off; a non-TTY shell skips the prompt. A preselected
        // `--embeddings` mode is instead configured ahead of the runtime gate (local
        // embeddings need no container runtime), so only the no-preselection flow
        // reaches this call — the guard keeps the preselected step from running a
        // second time here. See modules/embedding/setup.ts.
        if (options.embeddings === undefined) {
            const { runEmbeddingSetup } = await import("../embedding/setup.ts");
            const embedResult = await runEmbeddingSetup(process.stdin.isTTY, options.embeddings);
            if (embedResult.isErr()) {
                log.error(`Embedding setup: ${embedResult.error.message}`);
                process.exitCode = 1;
                return;
            }
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

// --- default-model selection (setup) ---------------------------------------
//
// After the CLIProxy login, interactive setup offers a default chat model: a preselected Auto row
// (labeled with the currently elected id) followed by the account's accessible models. Auto writes
// nothing — the default stays adaptive `model: null` resolution, which keeps electing the newest served
// model across launches. An explicit pick pins BOTH user-facing agents (per-agent divergence stays a
// picker power feature). Every id is discovered live from the proxy — none is ever hardcoded — so a
// proxy that is down or not yet answering simply skips the step: an optional convenience must not add a
// new way for setup to fail.

/**
 * How many accessibility checks the setup sweep runs at once. Small and fixed: it overlaps the
 * round-trips without firing the whole list at the upstream simultaneously (the design's bounded-sweep
 * requirement). No dependency — a hand-rolled worker pool over the ranked list.
 */
const SETUP_SWEEP_CONCURRENCY = 4;

/**
 * Filter a ranked id list to the ones the account can serve. ONLY a definite `not_found` hides a model;
 * an `inconclusive` check keeps it listed (the check failed, not the model) — the spec's "hide only
 * definitely inaccessible models". The fixed-size worker pool writes each verdict at its id's index, so
 * the surviving ids are read back in the original rank order.
 */
async function sweepAccessibleModels(check: (modelId: string) => Promise<ModelAccess>, ranked: string[]): Promise<string[]> {
    const verdicts = new Array<ModelAccess>(ranked.length);
    let next = 0;
    async function worker(): Promise<void> {
        for (let i = next++; i < ranked.length; i = next++) {
            verdicts[i] = await check(ranked[i]!);
        }
    }
    await Promise.all(Array.from({ length: Math.min(SETUP_SWEEP_CONCURRENCY, ranked.length) }, worker));
    return ranked.filter((_, i) => verdicts[i] !== "not_found");
}

/** The setup select's outcome: accept the adaptive Auto default, or pin a specific id. */
type DefaultModelChoice = { auto: true } | { auto: false; modelId: string };

/**
 * The seams {@link selectDefaultModel} drives, injectable so the TTY gate, the accessibility sweep, and
 * the Auto-vs-pin write policy are unit-testable without clack, a proxy, or a TTY. Production assembly:
 * {@link runDefaultModelSetup}.
 */
type DefaultModelDeps = {
    isInteractive: () => boolean;
    /** The ranked, connection-family candidate ids to sweep; empty (no listing / down proxy) → skip. */
    candidates: () => Promise<string[]>;
    /** One model's accessibility check, bounded like every probe round-trip. */
    check: (modelId: string) => Promise<ModelAccess>;
    /** Present Auto (preselected, labeled with `electedId`) atop `models`; returns the user's choice. */
    prompt: (electedId: string, models: string[]) => Promise<DefaultModelChoice>;
    /** Persist the chosen id to BOTH user-facing agents. */
    writeBoth: (modelId: string) => Result<void, ConfigError>;
    warn: (message: string) => void;
};

/**
 * The interactive default-model step. A non-TTY skips entirely (writes nothing — Auto semantics). An
 * empty candidate list (a down/unreachable proxy) or a sweep that rules out EVERY candidate skips
 * gracefully rather than turning an optional step into a failure or recommending a model the account
 * cannot serve. The Auto label is the first accessible candidate in rank order — the SAME id the launch
 * election resolves (both walk the ranked list past `not_found` to the first servable) — read straight
 * from the sweep, so the recommendation and the offered list can never disagree, and so setup makes ONE
 * `/models` pass rather than a separate election round-trip whose per-process cache this setup process
 * (which exits before any chat launch) would only discard. Accepting Auto writes nothing (the default
 * stays adaptive `model: null` resolution). An explicit pick persists to BOTH agents; a write failure
 * only warns — setup's real work is already done.
 */
export async function selectDefaultModel(deps: DefaultModelDeps): Promise<void> {
    if (!deps.isInteractive()) return;
    const ranked = await deps.candidates();
    if (ranked.length === 0) return;
    const models = await sweepAccessibleModels(deps.check, ranked);
    // Every candidate answered `not_found` — no servable model to recommend, so skip rather than preselect
    // a known-inaccessible id. This guard also makes `models[0]` provably present for the Auto label.
    if (models.length === 0) return;
    const electedId = models[0]!;
    const choice = await deps.prompt(electedId, models);
    if (choice.auto) return;
    deps.writeBoth(choice.modelId).match(
        () => {},
        (e) => deps.warn(`Could not save the model selection: ${e.type}`),
    );
}

/** The Auto row's sentinel value — a non-id token so it can never collide with a real model id. */
const AUTO_MODEL_SENTINEL = "__auto__";

/**
 * Production assembly of {@link selectDefaultModel} for the cliproxy setup path. Every model id is
 * discovered live from the raw `/models` list ({@link listModelCandidates}), ranked and filtered to the
 * connection family (in practice the rank already yields the winning family's pool); the sweep then both
 * offers and recommends from it. A missing proxy key or an unreachable/hung proxy resolves to a skip (the
 * key read short-circuits, and the bounded `candidates` fetch throws → `[]`), so a down proxy never fails
 * OR wedges setup. Cliproxy only — a direct connection has no owned proxy to elect against. The select
 * matches the surrounding setup prompts (`select` from lib/cli.ts), so a cancel aborts the command
 * exactly as they do.
 */
async function runDefaultModelSetup(mode: ConnectionMode): Promise<void> {
    if (mode !== "cliproxy") return;
    const key = await readApiKey();
    if (key.isErr()) return;
    const apiKey = key.value;
    const provider = resolveModelConnection().provider;
    await selectDefaultModel({
        isInteractive: () => Boolean(process.stdin.isTTY),
        // Bounded like every probe round-trip: this runs right after compose-up WITHOUT waiting on the
        // proxy's port bind, so a proxy that accepts the connection then never answers must not hang
        // setup — the timeout throws, which the Result maps to `[]` (skip), the same as a refused proxy.
        candidates: async () =>
            (await listModelCandidates(apiKey, AbortSignal.timeout(PROBE_TIMEOUT_MS))).match(
                (list) => rankModelCandidates(list).filter((id) => modelMatchesProvider(provider, id)),
                () => [],
            ),
        check: (modelId) => checkModelAccess(apiKey, modelId, AbortSignal.timeout(PROBE_TIMEOUT_MS)),
        prompt: async (electedId, models) => {
            const chosen = await select("Default chat model", [
                { value: AUTO_MODEL_SENTINEL, label: `Auto — recommended: ${electedId}` },
                ...models.map((id) => ({ value: id, label: id })),
            ]);
            return chosen === AUTO_MODEL_SENTINEL ? { auto: true } : { auto: false, modelId: chosen };
        },
        writeBoth: (modelId) => writeAgentModel("conversation", modelId).andThen(() => writeAgentModel("sandbox", modelId)),
        warn: (message) => log.warn(message),
    });
}

/**
 * The persist-only-explicit filter: keep ONLY the prompted fields that differ from their default (host
 * {@link DEFAULT_HOST}, database/user/password constants, port = any {@link isReservedPostgresPort reserved
 * channel default}), building the block FRESH from `conn` — never spread over the previous config block.
 *
 * WHY rebuild-fresh: `config.json` is shared by BOTH build channels, so persisting a value the user merely
 * ACCEPTED freezes it and overrides the OTHER channel's sibling default — re-creating exactly the port
 * collision the channel-aware defaults remove. Filtering to explicit differences means an accepted default
 * is written as nothing; and because the block is rebuilt from scratch each run (not merged over the old
 * one), a setup re-run that re-accepts the prompt is what HEALS a default an earlier run froze — the stale
 * `postgres.port` simply isn't carried forward. An all-defaults result is an empty object, so the caller
 * drops the `postgres` key entirely.
 *
 * WHY the port test is `isReservedPostgresPort`, not "equals THIS channel's default": both 8432 (prod) and
 * 8434 (dev) are reserved, so a value equal to EITHER is dropped regardless of which channel runs setup.
 * Dropping only the running channel's default would let setup on one channel re-persist the other channel's
 * default as if it were a real choice — the exact freeze this filter exists to prevent. Reserved-ness is a
 * pure function of the two channel defaults (no `env` read), so no default-port parameter is threaded here.
 *
 * Trade-off accepted: a user who explicitly TYPES a value equal to a channel default loses the pin — a
 * no-op on their own channel (it resolves to that default anyway), and never a value we'd let the other
 * channel adopt, since that is the collision case.
 */
export function explicitPostgresFields(conn: PostgresConnection): Partial<PostgresConnection> {
    const explicit: Partial<PostgresConnection> = {};
    if (conn.host !== DEFAULT_HOST) explicit.host = conn.host;
    if (!isReservedPostgresPort(conn.port)) explicit.port = conn.port;
    if (conn.database !== DEFAULT_DATABASE) explicit.database = conn.database;
    if (conn.user !== DEFAULT_USER) explicit.user = conn.user;
    if (conn.password !== DEFAULT_PASSWORD) explicit.password = conn.password;
    return explicit;
}

/**
 * Prompt for Postgres username, password, and port via @clack/prompts.
 * On non-interactive terminals, uses existing config values or defaults silently.
 * Empty input keeps the current value (the default is shown in the placeholder).
 *
 * Persists ONLY explicit choices (see {@link explicitPostgresFields}): a prompted value equal to its
 * channel-aware default writes nothing, and an all-defaults run removes the `postgres` block entirely so
 * each channel keeps resolving its own defaults. The returned connection is the full resolution used to
 * generate THIS run's compose file, independent of what was persisted.
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

    // A reserved port that is NOT this channel's own default is the OTHER build channel's reserved default
    // (pressing Enter on the placeholder yields THIS channel's default, which resolves silently). The spec
    // says a prompted value is used in THIS run's generated compose file regardless of what is persisted, so
    // we honor it here — but explicitPostgresFields never persists a reserved port, so the next run resolves
    // back to this channel's default. Warn about the non-persistence rather than rejecting a valid this-run
    // choice, which would contradict the spec.
    if (isReservedPostgresPort(port) && port !== env.postgresPort) {
        log.warn(
            `Port ${port} is the other build channel's reserved default. It will be used for this run's generated compose file, but is never persisted — the next run resolves back to this channel's default (${env.postgresPort}).`,
        );
    }

    const conn: PostgresConnection = {
        host: existing.host,
        port,
        database: existing.database,
        user,
        password,
    };

    const config = readConfig();
    // Rebuild the persisted block fresh from the prompt, keeping only explicit choices. An empty result
    // (all defaults) writes `postgres: undefined`, which JSON.stringify drops — healing a frozen default on
    // whichever channel runs setup, since a reserved port is never carried forward.
    const explicit = explicitPostgresFields(conn);
    const postgres = Object.keys(explicit).length === 0 ? undefined : explicit;
    writeConfig({ ...config, postgres }).match(
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
    lines.push(
        "Embeddings: run `inflexa setup` and pick a backend — the built-in model, your own GGUF, or an api-key endpoint — or edit it later in `inflexa config`.",
    );
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
 * The direct-mode secret's environment variable, as a NAME to show the user — the string every surface
 * that must tell them which variable to set (setup's next-steps, the chat auth banner) prints. It
 * mirrors lib/env.ts's `modelApiKeyVar`, the sole `process.env` reader, which does not export the name:
 * nothing here ever READS the variable, so this duplicates one display literal rather than widening
 * env.ts's surface with a value that would invite reading the secret from outside its owner.
 */
export const MODEL_API_KEY_VAR = "INFLEXA_MODEL_API_KEY";

/**
 * The Anthropic-wire Bearer variable. When set, setup OFFERS it as a `direct`-mode credential source
 * (`{ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" }`); the presence check is env.ts's
 * {@link anthropicAuthTokenSet}. Bedrock/Vertex remain out of scope (no direct-mode HTTP signer).
 */
const ANTHROPIC_AUTH_TOKEN_VAR = "ANTHROPIC_AUTH_TOKEN";

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

// --- ecosystem env adoption ------------------------------------------------
//
// The two ecosystems setup can adopt from the conventional provider env vars, each mapping to fixed
// wire facts: ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL ⇒ provider `anthropic`, protocol `anthropic`;
// OPENAI_API_KEY/OPENAI_BASE_URL ⇒ provider `openai`, protocol `openai-compatible` (the OpenAI path
// also covers the Groq/Ollama/vLLM/LiteLLM long tail via a custom OPENAI_BASE_URL).

/** A provider ecosystem setup can adopt from the environment. */
export type AdoptableProvider = "anthropic" | "openai";

/** Public API roots used when no `*_BASE_URL` is exported — the `/v1`-terminated form the wire layer needs. */
const ANTHROPIC_PUBLIC_ROOT = "https://api.anthropic.com/v1";
const OPENAI_PUBLIC_ROOT = "https://api.openai.com/v1";

/**
 * Which ecosystems are adoptable (their API key is present), in the deterministic anthropic-before-openai
 * precedence (design D6): a non-TTY setup adopts `[0]`, and an interactive both-present offer lists them
 * in this order. An empty array means no conventional provider env was detected.
 */
export function detectedAdoptable(snap: ProviderEnvSnapshot): AdoptableProvider[] {
    const out: AdoptableProvider[] = [];
    if (snap.anthropicApiKeySet) out.push("anthropic");
    if (snap.openaiApiKeySet) out.push("openai");
    return out;
}

/**
 * Normalize an adopted provider `baseURL` to the `/v1`-terminated form the wire layer requires (it POSTs
 * `{baseURL}/messages` | `{baseURL}/chat/completions` and GETs `{baseURL}/models`). The conventions are
 * ASYMMETRIC: `ANTHROPIC_BASE_URL` is a BARE root (`https://api.anthropic.com`; the Anthropic SDK appends
 * `/v1/…`), whereas `OPENAI_BASE_URL` is usually already `/v1`-terminated — so `/v1` is appended ONLY when
 * the path carries no `vN` version segment, leaving an already-versioned URL untouched. An unset
 * `*_BASE_URL` defaults to the provider's public root. Because a gateway root like `https://gw.corp/anthropic`
 * is genuinely ambiguous, the result is shown to the user as an EDITABLE pre-fill (see
 * {@link promptDirectConnection}) — the normalization is a best guess the user confirms, not a silent rewrite.
 */
export function normalizeAdoptedBaseURL(provider: AdoptableProvider, rawBaseURL: string | undefined): string {
    if (rawBaseURL === undefined || rawBaseURL.trim() === "") {
        return provider === "anthropic" ? ANTHROPIC_PUBLIC_ROOT : OPENAI_PUBLIC_ROOT;
    }
    const trimmed = rawBaseURL.trim().replace(/\/+$/, ""); // drop trailing slashes so we never emit `…//v1`
    return hasVersionSegment(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * True when the URL's PATH already ends in a `/vN` version segment (any integer), so `/v1` must not be
 * re-appended. Parses to inspect only the pathname — a `v1` in the host (`v1.gw.corp`) or a query must
 * not count. `new URL` is guarded by `URL.canParse`, so it cannot throw here.
 */
function hasVersionSegment(url: string): boolean {
    if (!URL.canParse(url)) return false;
    const { pathname } = new URL(url);
    return /\/v\d+\/?$/.test(pathname);
}

/**
 * The non-secret connection an ecosystem adopts into config — the normalized `{ provider, baseURL,
 * protocol }` written verbatim by {@link writeDirectConnection}. The API key is deliberately absent: it
 * stays an environment read via {@link resolveModelApiKey}, never copied.
 */
export function adoptedConnection(which: AdoptableProvider, snap: ProviderEnvSnapshot): DirectConnectionInput {
    return which === "anthropic"
        ? { provider: "anthropic", baseURL: normalizeAdoptedBaseURL("anthropic", snap.anthropicBaseURL), protocol: "anthropic" }
        : { provider: "openai", baseURL: normalizeAdoptedBaseURL("openai", snap.openaiBaseURL), protocol: "openai-compatible" };
}

/**
 * Collect a direct connection interactively, most-configured source first: a key-bearing provider env
 * (the classic adoption), then a credential-helper GATEWAY (endpoint from the Claude settings `env`
 * block or a key-less shell `ANTHROPIC_BASE_URL` — see {@link detectedGatewayURL}), then the manual
 * endpoint/provider/protocol prompts. Declining any offer falls through to the next. Only
 * `{ provider, baseURL, protocol }` are ever produced; the key is never read here.
 */
async function promptDirectConnection(
    snap: ProviderEnvSnapshot,
    adoptable: AdoptableProvider[],
    detection: CredentialHelperDetection,
): Promise<DirectConnectionInput> {
    if (adoptable.length > 0) {
        const offered = await offerAdoption(snap, adoptable);
        if (offered !== null) return offered;
        // Declined the offer → fall through to the gateway offer / manual entry.
    }
    const gatewayURL = detectedGatewayURL(detection, snap);
    if (gatewayURL !== null) {
        const offered = await offerGatewayAdoption(gatewayURL);
        if (offered !== null) return offered;
    }
    return promptManualDirectConnection();
}

/**
 * The gateway endpoint a credential-helper setup implies, or `null` when there is nothing to offer.
 * Requires a credential signal: a bare `ANTHROPIC_BASE_URL` with no helper and no auth token is not a
 * usable connection (there is nothing to authenticate with), and offering it would dead-end at boot.
 * Precedence mirrors the helper itself: the Claude settings files (managed first — the org pinned it
 * beside the helper command) over a shell export. Pure, so the offer decision is unit-testable.
 */
export function detectedGatewayURL(detection: CredentialHelperDetection, snap: ProviderEnvSnapshot): string | null {
    if (!credentialHelperDetected(detection)) return null;
    return detection.settingsBaseURL ?? snap.anthropicBaseURL ?? null;
}

/**
 * Offer the credential-helper gateway endpoint as an editable pre-fill, mirroring {@link offerAdoption}'s
 * confirm step: the raw URL is normalized to the `/v1`-terminated root (Claude Code's
 * `ANTHROPIC_BASE_URL` is a bare root by convention) but shown for the user to confirm or edit — a
 * gateway path like `/anthropic` is genuinely ambiguous, so this is a best guess, never a silent write.
 * Returns the confirmed anthropic-wire connection, or `null` when the user chooses manual entry.
 */
async function offerGatewayAdoption(gatewayURL: string): Promise<DirectConnectionInput | null> {
    const chosen = await select(`Detected an Anthropic gateway endpoint in your Claude settings (${gatewayURL}) — use it?`, [
        { value: "adopt", label: "Use this gateway (recommended)" },
        { value: "_manual", label: "Enter the connection manually instead" },
    ]);
    if (chosen === "_manual") return null;

    const prefill = normalizeAdoptedBaseURL("anthropic", gatewayURL);
    const baseURL = await promptText("Model endpoint URL — the /v1-terminated root (confirm the pre-fill, or edit)", {
        defaultValue: prefill,
        placeholder: prefill,
        validate: (v) => {
            const s = v.trim();
            if (s === "") return undefined; // empty submit keeps the pre-filled default
            if (!URL.canParse(s)) return "Must be a valid URL, including the scheme (e.g. https://…).";
            return undefined;
        },
    });
    const confirmedURL = baseURL.trim() === "" ? prefill : baseURL.trim();
    return { provider: "anthropic", baseURL: confirmedURL, protocol: "anthropic" };
}

/**
 * Offer to adopt a detected ecosystem env: ask which when both are present (design D6), then show the
 * normalized `baseURL` as an EDITABLE pre-fill so an ambiguous gateway root is a one-keystroke edit, not
 * a silent 404 (design D4). Returns the confirmed connection, or `null` when the user chooses manual entry.
 */
async function offerAdoption(snap: ProviderEnvSnapshot, adoptable: AdoptableProvider[]): Promise<DirectConnectionInput | null> {
    let which: AdoptableProvider;
    if (adoptable.length > 1) {
        const chosen = await select("Detected both ANTHROPIC_* and OPENAI_* — adopt which provider environment?", [
            { value: "anthropic", label: `Anthropic — ANTHROPIC_API_KEY${snap.anthropicBaseURL ? ` (${snap.anthropicBaseURL})` : ""}` },
            { value: "openai", label: `OpenAI — OPENAI_API_KEY${snap.openaiBaseURL ? ` (${snap.openaiBaseURL})` : ""}` },
            { value: "_manual", label: "Enter the connection manually instead" },
        ]);
        if (chosen === "_manual") return null;
        which = chosen as AdoptableProvider;
    } else {
        which = adoptable[0]!;
        const keyVar = which === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
        const chosen = await select(`Detected ${keyVar} — adopt this provider environment?`, [
            { value: "adopt", label: "Adopt the detected environment (recommended)" },
            { value: "_manual", label: "Enter the connection manually instead" },
        ]);
        if (chosen === "_manual") return null;
    }

    const prefill = adoptedConnection(which, snap);
    const baseURL = await promptText("Model endpoint URL — the /v1-terminated root (confirm the pre-fill, or edit for a gateway)", {
        defaultValue: prefill.baseURL,
        placeholder: prefill.baseURL,
        validate: (v) => {
            const s = v.trim();
            if (s === "") return undefined; // empty submit keeps the pre-filled default
            if (!URL.canParse(s)) return "Must be a valid URL, including the scheme (e.g. https://…).";
            return undefined;
        },
    });
    const confirmedURL = baseURL.trim() === "" ? prefill.baseURL : baseURL.trim();
    return { provider: prefill.provider, baseURL: confirmedURL, protocol: prefill.protocol };
}

/**
 * Collect a direct connection from scratch: the endpoint URL (must parse as a URL), the provider slug
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
async function promptManualDirectConnection(): Promise<DirectConnectionInput> {
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
    /** An optional REFRESHING credential source (name/command + scheme, never a token) — {@link offerCredentialSource}. */
    auth?: ModelAuthConfig;
};

/**
 * Persist a direct-mode model connection. Spread-preserving: keeps every other config key and every
 * other key inside the `models` block (e.g. the `agents` overrides), rewriting only `connection`. No token
 * is EVER written here — the static key comes from {@link MODEL_API_KEY_VAR} at provider construction, and a
 * configured `auth` block persists only the non-secret variable name / command string / scheme.
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
        // The credential source is token-free by construction (setup only ever attaches a {kind, var|command, scheme}).
        ...(input.auth !== undefined && { auth: input.auth }),
    };
    return writeConfig({ ...config, models: { ...models, connection } });
}

// --- credential-source auth (direct mode) ----------------------------------
//
// A `direct` connection may draw its wire token from a refreshing credential source instead of a static key:
// a helper command (Claude Code `apiKeyHelper` parity) or a short-lived env bearer. Setup detects one from
// read-only signals and OFFERS the path opt-in — the user confirms the command (never the org-managed helper
// auto-executed) — then VALIDATES the source before its token-free `auth` block is written. The refresh /
// injection lives at the wire (modules/harness/runtime.ts).

/**
 * The read-only signals that a credential-helper Anthropic setup exists. A pure shape (no IO) so the
 * offer/precedence is unit-testable. User-level vs org-managed is tracked SEPARATELY because they are
 * offered differently: the user's OWN `apiKeyHelper` is the recommended default, while the org-managed
 * one is shown for the user to explicitly pick and confirm — never silently merged into the user path,
 * and NEVER executed before the user has seen and accepted the exact command (the probe runs it only
 * after that confirmation).
 */
export type CredentialHelperDetection = {
    /** An `apiKeyHelper` from the user's OWN `~/.claude/settings.json` — pre-fillable as an editable default. */
    readonly userHelperCommand: string | null;
    /**
     * The `apiKeyHelper` from the org-managed Claude Code settings (the per-platform
     * `managed-settings.json`), or `null` when absent/unreadable. Offered as its own EXPLICIT choice —
     * shown to the user, editable before use, and executed only after they select and confirm it.
     */
    readonly managedHelperCommand: string | null;
    /** `ANTHROPIC_AUTH_TOKEN` is set — the env-bearer source is offerable. */
    readonly authTokenEnvSet: boolean;
    /**
     * The `env.ANTHROPIC_BASE_URL` from the same Claude settings files (managed first, then the user's
     * own), or `null`. This is where an org pins its GATEWAY endpoint beside the helper command — Claude
     * Code applies the settings `env` block internally, so it never reaches the shell environment and
     * the process-env adoption path cannot see it. A URL is configuration, not a credential: it is
     * offered as an editable pre-fill with no confirm-before-use ceremony beyond the offer itself.
     */
    readonly settingsBaseURL: string | null;
};

/** True when ANY credential-helper signal was detected, so setup should offer the credential-source path. */
export function credentialHelperDetected(d: CredentialHelperDetection): boolean {
    return d.userHelperCommand !== null || d.managedHelperCommand !== null || d.authTokenEnvSet;
}

/**
 * Assemble the detection from its raw signals — pure, so the offer logic (and the "managed helper is
 * never executed without explicit confirmation" guarantee) is testable without touching the filesystem
 * or environment.
 */
export function detectCredentialHelperFrom(
    userHelperCommand: string | null,
    managedHelperCommand: string | null,
    authTokenEnvSet: boolean,
    settingsBaseURL: string | null = null,
): CredentialHelperDetection {
    return { userHelperCommand, managedHelperCommand, authTokenEnvSet, settingsBaseURL };
}

/** The user's OWN Claude Code settings — an `apiKeyHelper` here is theirs, so setup may pre-fill it as an editable default. */
function userClaudeSettingsPath(): string {
    return join(homedir(), ".claude", "settings.json");
}

/**
 * The org-managed Claude Code settings locations, most-specific first (Claude Code's documented
 * per-platform managed-settings paths — this is the standard place an enterprise MDM/IT deploys the
 * org's `apiKeyHelper`). macOS additionally probes the per-user `~/Library` twin of the system path:
 * some IT rollouts install there ("Library/Application Support/…" in per-user install docs), and a
 * read-only existence probe of one extra path is free. An `apiKeyHelper` found here belongs to the
 * organization: setup shows it as an explicit choice but never runs it before the user confirms the
 * exact command — the governance decision stays with the user, and the file may need special env anyway.
 */
function managedClaudeSettingsPaths(): string[] {
    if (process.platform === "darwin") {
        return [
            "/Library/Application Support/ClaudeCode/managed-settings.json",
            join(homedir(), "Library", "Application Support", "ClaudeCode", "managed-settings.json"),
        ];
    }
    if (process.platform === "win32") return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
    return ["/etc/claude-code/managed-settings.json"];
}

/** The two setup-relevant facts a Claude Code settings file can carry — both `null` when absent. */
type ClaudeSettingsRead = {
    readonly helper: string | null;
    readonly baseURL: string | null;
};

/**
 * Read a Claude Code settings file's `apiKeyHelper` command and `env.ANTHROPIC_BASE_URL` (the gateway
 * endpoint an org pins beside the helper), each `null` when the file is absent / unreadable / lacks the
 * field. Boundary-wrapped: a missing file is the common case, not an error — a settings file usually
 * does not exist, so `readFileSync` throwing ENOENT resolves to the all-null read.
 */
function readClaudeSettings(path: string): ClaudeSettingsRead {
    const none: ClaudeSettingsRead = { helper: null, baseURL: null };
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8")); // on-disk settings — shape-narrowed below
        if (typeof parsed !== "object" || parsed === null) return none;
        // Narrowed to a non-null object above, so a Record view for the field reads is sound.
        const record = parsed as Record<string, unknown>;
        const helper = record.apiKeyHelper;
        const envBlock = record.env;
        const baseURL = typeof envBlock === "object" && envBlock !== null ? (envBlock as Record<string, unknown>).ANTHROPIC_BASE_URL : undefined;
        return {
            helper: typeof helper === "string" && helper.trim() !== "" ? helper.trim() : null,
            baseURL: typeof baseURL === "string" && baseURL.trim() !== "" ? baseURL.trim() : null,
        };
    } catch {
        return none;
    }
}

/**
 * Detect a credential-helper setup from read-only signals: the user's + org-managed Claude settings, and
 * `ANTHROPIC_AUTH_TOKEN` in the environment (read via env.ts, the sole `process.env` reader). A configured
 * `claude auth status` api-key-helper method writes an `apiKeyHelper` into settings.json, so the
 * settings-file signal already subsumes it — no fragile `claude` subprocess is spawned.
 */
function detectCredentialHelper(): CredentialHelperDetection {
    // Per FIELD, the first managed location that yields a value wins (paths are ordered
    // most-authoritative first) — a rollout may split the helper and the gateway URL across the
    // system/user twins, and keying both on whichever file carried the helper would drop the URL.
    let managedHelper: string | null = null;
    let managedBaseURL: string | null = null;
    for (const path of managedClaudeSettingsPaths()) {
        const read = readClaudeSettings(path);
        managedHelper = managedHelper ?? read.helper;
        managedBaseURL = managedBaseURL ?? read.baseURL;
    }
    const user = readClaudeSettings(userClaudeSettingsPath());
    return detectCredentialHelperFrom(user.helper, managedHelper, anthropicAuthTokenSet(), managedBaseURL ?? user.baseURL);
}

/** The wire protocol a direct connection speaks, resolving the "infer from provider" default the way `resolveModelConnection` does — the probe needs it to add the anthropic version header. */
function effectiveProtocol(direct: DirectConnectionInput): "anthropic" | "openai-compatible" {
    return direct.protocol ?? (direct.provider === "anthropic" ? "anthropic" : "openai-compatible");
}

/** Why the setup credential probe failed — a single actionable message naming the likely cause (command, scheme, or endpoint). */
export type CredentialProbeError = { readonly message: string };

/**
 * A probe conclusion the caller must act on (the ok channel — failure means a DEFINITE bad
 * configuration, see {@link probeCredentialSource}). `pass` carries the `/models` ids when that rung
 * answered 2xx (they seed the model prompt's pre-fill) and `validatedModel` when the authoritative ping
 * confirmed a specific id end-to-end (so the model step can skip re-validating the same pick).
 * `ambiguous` is the save-anyway path: the endpoint answered something a standards-shaped client cannot
 * classify (enterprise gateways signal auth failures with non-standard statuses, e.g. 500), so the user
 * — shown the status and body — decides. Both carry the minted credential so later setup steps (the
 * model validation) reuse it instead of re-running the helper.
 */
export type CredentialProbeResult =
    | { readonly outcome: "pass"; readonly listedModels: string[] | null; readonly validatedModel: string | null; readonly cred: Credential }
    | { readonly outcome: "ambiguous"; readonly status: number; readonly excerpt: string; readonly cred: Credential };

/** The wire headers a direct request sends under a resolved credential: the scheme's auth header, plus the version header the anthropic wire requires. */
function wireHeaders(cred: Credential, protocol: "anthropic" | "openai-compatible"): Headers {
    const headers = new Headers();
    if (cred.scheme === "bearer") headers.set("authorization", `Bearer ${cred.token}`);
    else headers.set("x-api-key", cred.token);
    // The Anthropic Messages API requires a version header on every request, GET /models included.
    if (protocol === "anthropic") headers.set("anthropic-version", "2023-06-01");
    return headers;
}

/** The `/models` ids of a 2xx listing body, or `null` when the body is not the shared `{ data: [{ id }] }` shape. */
const probeModelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/**
 * How the authoritative message ping concluded. `model_not_found` is a PASS for a credential probe (the
 * request cleared auth and routing — everything a credential probe asserts) but a rejection for a model
 * validation; the two callers map it themselves.
 */
export type MessagePingOutcome =
    | { readonly kind: "pass" }
    | { readonly kind: "model_not_found"; readonly excerpt: string }
    | { readonly kind: "auth_rejected"; readonly status: number }
    | { readonly kind: "ambiguous"; readonly status: number; readonly excerpt: string }
    | { readonly kind: "unreachable"; readonly url: string; readonly detail: string };

/**
 * True only for a RECOGNIZABLE model-not-found error body: the Anthropic shape (`error.type ===
 * "not_found_error"` whose message names the model — a bare not_found_error is also what a wrong URL
 * path returns, and reading that as "model wrong" would wave a broken endpoint through) or the
 * OpenAI-style `error.code === "model_not_found"`. Anything else stays unclassified — the conservative
 * read keeps the user in control via the ambiguous/save-anyway path.
 */
function isModelNotFoundBody(text: string): boolean {
    try {
        const parsed: unknown = JSON.parse(text); // endpoint error body — shape-narrowed below
        if (typeof parsed !== "object" || parsed === null) return false;
        const error = (parsed as Record<string, unknown>).error;
        if (typeof error !== "object" || error === null) return false;
        const { type, code, message } = error as Record<string, unknown>;
        if (code === "model_not_found") return true;
        return type === "not_found_error" && typeof message === "string" && message.toLowerCase().includes("model");
    } catch {
        return false;
    }
}

/**
 * The authoritative probe rung: a `max_tokens: 1` message POST shaped by the connection's protocol —
 * the one request that tests a NECESSARY condition of the connection (an endpoint that cannot serve it
 * cannot chat, whatever else answers). ~10 tokens, sent only from interactive setup with the progress
 * line naming the spend.
 */
export async function pingMessagesEndpoint(
    baseURL: string,
    protocol: "anthropic" | "openai-compatible",
    cred: Credential,
    model: string,
    doFetch: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<MessagePingOutcome> {
    const root = baseURL.replace(/\/+$/, "");
    const url = protocol === "anthropic" ? `${root}/messages` : `${root}/chat/completions`;
    const headers = wireHeaders(cred, protocol);
    headers.set("content-type", "application/json");
    let response: Response;
    try {
        response = await doFetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        });
    } catch (cause) {
        return { kind: "unreachable", url, detail: cause instanceof Error ? cause.message : String(cause) };
    }
    if (response.ok) return { kind: "pass" };
    if (response.status === 401 || response.status === 403) return { kind: "auth_rejected", status: response.status };
    const excerpt = (await response.text().catch(() => "")).slice(0, 300);
    if (isModelNotFoundBody(excerpt)) return { kind: "model_not_found", excerpt };
    return { kind: "ambiguous", status: response.status, excerpt };
}

/**
 * Validate a credential source before it is persisted, with a PROBE LADDER in which `GET
 * {baseURL}/models` is opportunistic and the message ping is authoritative: enterprise gateways
 * routinely serve ONLY the message route, so a missing/broken `/models` must never read as a broken
 * credential. Run the source ONCE — surfacing a command/env failure as its own cause — then:
 *
 * 1. `GET {baseURL}/models` under the resolved scheme. 2xx passes (its ids seed the model pre-fill);
 *    401/403 fails with the scheme hint; an unreachable endpoint fails with the URL hint.
 * 2. Any other listing outcome (404, 405, 5xx …) escalates to {@link pingMessagesEndpoint} with
 *    `pingModel`: 2xx or a definite model-not-found passes (the latter proves auth + routing, which is
 *    all a credential probe asserts); 401/403 and unreachable fail as above; anything else returns the
 *    `ambiguous` outcome for the caller's save-anyway decision.
 *
 * `doFetch` is injectable for tests; production uses global `fetch`.
 */
export async function probeCredentialSource(
    baseURL: string,
    protocol: "anthropic" | "openai-compatible",
    auth: ModelAuthConfig,
    pingModel: string,
    doFetch: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Result<CredentialProbeResult, CredentialProbeError>> {
    const cred = await createCredentialSource(auth).get();
    if (cred.isErr()) {
        return err({
            message: `The credential ${auth.kind === "command" ? "command" : "source"} did not produce a token: ${credentialErrorMessage(cred.error)}.`,
        });
    }
    const rejected = (status: number): CredentialProbeError => ({
        message: `The endpoint rejected the credential (HTTP ${status}). Check the ${cred.value.scheme} scheme and that the source mints a valid token for ${baseURL}.`,
    });

    const url = `${baseURL.replace(/\/+$/, "")}/models`;
    let response: Response;
    try {
        response = await doFetch(url, { method: "GET", headers: wireHeaders(cred.value, protocol) });
    } catch (cause) {
        return err({ message: `Could not reach the endpoint ${url}: ${cause instanceof Error ? cause.message : String(cause)}. Check the endpoint URL.` });
    }
    if (response.status === 401 || response.status === 403) return err(rejected(response.status));
    if (response.ok) {
        // A listing that answers but does not parse still validated the credential — the ids are a bonus.
        let listedModels: string[] | null;
        try {
            const parsed = probeModelsSchema.safeParse(await response.json());
            listedModels = parsed.success ? parsed.data.data.map((m) => m.id) : null;
        } catch {
            listedModels = null;
        }
        return ok({ outcome: "pass", listedModels, validatedModel: null, cred: cred.value });
    }

    const ping = await pingMessagesEndpoint(baseURL, protocol, cred.value, pingModel, doFetch);
    switch (ping.kind) {
        case "pass":
            return ok({ outcome: "pass", listedModels: null, validatedModel: pingModel, cred: cred.value });
        case "model_not_found":
            return ok({ outcome: "pass", listedModels: null, validatedModel: null, cred: cred.value });
        case "auth_rejected":
            return err(rejected(ping.status));
        case "unreachable":
            return err({ message: `Could not reach the endpoint ${ping.url}: ${ping.detail}. Check the endpoint URL.` });
        case "ambiguous":
            return ok({ outcome: "ambiguous", status: ping.status, excerpt: ping.excerpt, cred: cred.value });
    }
}

/** Shorten a command for a menu label so a long helper path does not wrap the clack box. */
function truncateCommand(s: string, max = 44): string {
    return s.length <= max ? s : `${s.slice(0, max - 1)}...`;
}

/**
 * Offer the credential-source path for a detected helper setup. Opt-in: the user chooses a credential
 * command — pre-filled from their OWN settings, or from the ORG-MANAGED `managed-settings.json` as its
 * own explicitly-labeled choice, both always editable — the `ANTHROPIC_AUTH_TOKEN` env bearer (when
 * set), or declines to the static-key path. The managed helper is never run before the user has seen
 * and confirmed the exact command in the editable prompt. The chosen source is VALIDATED (run once +
 * the probe ladder) before it is returned; a DEFINITE probe failure (auth rejection, unreachable,
 * mint failure) reports the likely cause and returns `null` (falling back to the static key), while an
 * AMBIGUOUS outcome — a non-standard status like the 500-for-bad-token some gateways emit — shows the
 * endpoint's answer and lets the user save anyway rather than silently discarding a possibly-working
 * source. Returns the token-free `auth` block with the probe conclusion (listing ids for the model
 * pre-fill, the minted credential for later validation), or `null`.
 */
async function offerCredentialSource(
    direct: DirectConnectionInput,
    detection: CredentialHelperDetection,
): Promise<{ auth: ModelAuthConfig; probe: CredentialProbeResult } | null> {
    const options: { value: string; label: string }[] = [];
    if (detection.userHelperCommand !== null) {
        options.push({
            value: "command_prefill",
            label: `Use the credential command from ~/.claude/settings.json (${truncateCommand(detection.userHelperCommand)})`,
        });
    }
    if (detection.managedHelperCommand !== null) {
        options.push({
            value: "command_prefill_managed",
            label: `Use your organization's managed credential command (${truncateCommand(detection.managedHelperCommand)})`,
        });
    }
    options.push({ value: "command", label: "Run a credential command to mint a short-lived token" });
    if (detection.authTokenEnvSet) options.push({ value: "env_bearer", label: `Use ${ANTHROPIC_AUTH_TOKEN_VAR} from your environment (bearer)` });
    options.push({ value: "_skip", label: "Skip — use a static API key from the environment" });

    const chosen = await select("A credential-helper setup was detected. How should inflexa obtain the model token?", options);
    if (chosen === "_skip") return null;

    let auth: ModelAuthConfig;
    if (chosen === "env_bearer") {
        auth = { kind: "env", var: ANTHROPIC_AUTH_TOKEN_VAR, scheme: "bearer" };
    } else {
        const prefill =
            chosen === "command_prefill"
                ? (detection.userHelperCommand ?? "")
                : chosen === "command_prefill_managed"
                  ? (detection.managedHelperCommand ?? "")
                  : "";
        const command = (
            await promptText("Credential command (its stdout is the token — Claude Code apiKeyHelper compatible)", {
                ...(prefill !== "" && { defaultValue: prefill, placeholder: prefill }),
                validate: (v) => (v.trim() === "" ? "Enter a command." : undefined),
            })
        ).trim();
        // Infer a scheme default and let the user override (the probe validates it either way): a personal
        // apiKeyHelper conventionally mints an `x-api-key`, while an ORG-MANAGED helper fronting an
        // enterprise gateway conventionally mints a short-lived OAuth access token sent as a Bearer — so
        // the managed choice lists bearer first. Our `select` has no initialValue; ordering IS the default.
        const schemeOptions = [
            { value: "x-api-key", label: "x-api-key header (a minted API key — apiKeyHelper default)" },
            { value: "bearer", label: "Authorization: Bearer (an OAuth / WIF / enterprise-gateway access token)" },
        ];
        if (chosen === "command_prefill_managed") schemeOptions.reverse();
        const scheme = (await select("How is the minted token sent on the wire?", schemeOptions)) as CredentialScheme;
        auth = { kind: "command", command, scheme };
    }

    const s = clackSpinner();
    s.start("Validating the credential source (may send one 1-token test message)");
    // The ping needs SOME model id; the provider-conventional default is the best guess, and a
    // model-not-found answer still passes (the probe asserts auth + routing, not the model). This offer
    // only runs on the anthropic wire, so a custom provider slug falls back to the anthropic family's
    // entry — the table stays the single home of conventional ids; the literal is an unreachable
    // backstop for the type system, not a real guess.
    const pingModel = conventionalDefaultModel(direct.provider) ?? conventionalDefaultModel("anthropic") ?? "unknown";
    const probe = await probeCredentialSource(direct.baseURL, effectiveProtocol(direct), auth, pingModel);
    if (probe.isErr()) {
        s.error("Credential source validation failed");
        log.error(probe.error.message);
        log.warn("Not writing the credential source — falling back to a static API key. Re-run `inflexa setup` to try again.");
        return null;
    }
    if (probe.value.outcome === "ambiguous") {
        s.stop("Credential source validation was inconclusive");
        log.warn(
            `The endpoint answered the test message with HTTP ${probe.value.status}${probe.value.excerpt !== "" ? `:\n  ${probe.value.excerpt}` : "."}\n` +
                "Enterprise gateways often use non-standard statuses, so the source may still work.",
        );
        if (!(await confirm("Save the credential source anyway?"))) {
            log.warn("Not writing the credential source — falling back to a static API key. Re-run `inflexa setup` to try again.");
            return null;
        }
        return { auth, probe: probe.value };
    }
    s.stop("Credential source validated");
    return { auth, probe: probe.value };
}

/**
 * The seams {@link collectDirectModel} drives, injectable so the validation verdict mapping, the
 * re-prompt loop, and the save-anyway policy are unit-testable without clack or a network — mirrors
 * {@link selectDefaultModel}'s deps pattern. Production assembly: {@link collectDirectModelAtSetup}.
 */
export type DirectModelDeps = {
    /** The editable pre-fill (three-tier precedence, computed by the assembly); "" = no guess. */
    prefill: string;
    /** The id the credential probe already validated end-to-end, or null; a matching pick skips re-validation. */
    validatedModel: string | null;
    /** Prompt for the model id; `retryDetail` carries the endpoint's rejection to show above a re-prompt. */
    promptModel: (prefill: string, retryDetail: string | null) => Promise<string>;
    /** The protocol-shaped 1-token validation, or null when no credential is at hand (persist unvalidated). */
    validate: ((model: string) => Promise<MessagePingOutcome>) | null;
    /** The save-anyway decision for a validation outcome that neither passed nor definitely rejected. */
    confirmSave: (model: string, detail: string) => Promise<boolean>;
    /** Persist the id to BOTH user-facing agents. */
    writeBoth: (model: string) => Result<void, ConfigError>;
    warn: (message: string) => void;
    success: (message: string) => void;
};

/**
 * Collect and persist the direct connection's model id — the piece without which boot fails
 * `model_required`. The confirmed id is validated when a credential is at hand: a definite
 * model-not-found re-prompts with the endpoint's own rejection (endpoints often name their served ids
 * there); an outcome the validation cannot classify (auth-rejected, unreachable, non-standard status)
 * offers save-anyway — declining re-prompts; a pass — or no validation capability at all — persists to
 * BOTH agents (the cliproxy election's explicit-pick semantics). A write failure only warns: setup's
 * real work is already done, and the model-switch commands can persist the pick later.
 */
export async function collectDirectModel(deps: DirectModelDeps): Promise<void> {
    let retryDetail: string | null = null;
    for (;;) {
        const model = (await deps.promptModel(deps.prefill, retryDetail)).trim();
        retryDetail = null;
        if (model === "") continue;
        if (deps.validate !== null && model !== deps.validatedModel) {
            const outcome = await deps.validate(model);
            if (outcome.kind === "model_not_found") {
                retryDetail = outcome.excerpt !== "" ? outcome.excerpt : "the endpoint reports it cannot serve this model";
                continue;
            }
            if (outcome.kind !== "pass") {
                const detail =
                    outcome.kind === "unreachable"
                        ? outcome.detail
                        : `HTTP ${outcome.status}${outcome.kind === "ambiguous" && outcome.excerpt !== "" ? `: ${outcome.excerpt}` : ""}`;
                if (!(await deps.confirmSave(model, detail))) continue;
            }
        }
        deps.writeBoth(model).match(
            () => deps.success(`Model "${model}" set for both agents.`),
            (e) => deps.warn(`Could not save the model selection: ${e.type}. Set it later with the model-switch commands.`),
        );
        return;
    }
}

/**
 * The model prompt's pre-fill (spec precedence): the top-RANKED listed id when the endpoint's listing
 * answered → the provider-conventional default → "" (free text, no guess). Pure, so the precedence is
 * unit-testable without a prompt or a network.
 */
export function directModelPrefill(listed: string[] | null, provider: string): string {
    const ranked = listed !== null && listed.length > 0 ? rankModelCandidates(listed.map((id) => ({ id }))) : [];
    return ranked[0] ?? conventionalDefaultModel(provider) ?? "";
}

/** One `/models` listing attempt for the static-key pre-fill; any failure (non-2xx, parse, network) degrades to null — never an error. */
async function fetchDirectListing(baseURL: string, protocol: "anthropic" | "openai-compatible", cred: Credential): Promise<string[] | null> {
    try {
        const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, { method: "GET", headers: wireHeaders(cred, protocol) });
        if (!response.ok) return null;
        const parsed = probeModelsSchema.safeParse(await response.json());
        return parsed.success ? parsed.data.data.map((m) => m.id) : null;
    } catch {
        return null;
    }
}

/**
 * Production assembly of {@link collectDirectModel} for the interactive direct path. The validation
 * credential is the probe's minted token when an auth block was configured (no second helper run), else
 * the static env key under the protocol's conventional header (`x-api-key` on the anthropic wire, bearer
 * on openai-compatible — what the SDK sends at chat time); absent both, the pick persists unvalidated
 * (boot and first chat surface problems actionably). Pre-fill precedence (spec): the endpoint's ranked
 * `/models` listing — from the probe, or one attempt of our own on the static-key path — then the
 * provider-conventional default, then empty free text.
 */
async function collectDirectModelAtSetup(direct: DirectConnectionInput, probe: CredentialProbeResult | null): Promise<void> {
    const protocol = effectiveProtocol(direct);
    const envKey = resolveModelApiKey(direct.provider);
    const cred: Credential | null = probe?.cred ?? (envKey !== undefined ? { token: envKey, scheme: protocol === "anthropic" ? "x-api-key" : "bearer" } : null);

    let listed = probe !== null && probe.outcome === "pass" ? probe.listedModels : null;
    if (listed === null && probe === null && cred !== null) {
        listed = await fetchDirectListing(direct.baseURL, protocol, cred);
    }
    const prefill = directModelPrefill(listed, direct.provider);

    await collectDirectModel({
        prefill,
        validatedModel: probe !== null && probe.outcome === "pass" ? probe.validatedModel : null,
        promptModel: async (pf, retryDetail) => {
            if (retryDetail !== null) log.error(`The endpoint rejected the model:\n  ${retryDetail}`);
            const entered = await promptText("Model id the endpoint serves (required for chat)", {
                ...(pf !== "" && { defaultValue: pf, placeholder: pf }),
                validate: (v) => (v.trim() === "" && pf === "" ? "Enter a model id." : undefined),
            });
            // Empty submit keeps the pre-filled default (the offerGatewayAdoption convention).
            return entered.trim() === "" ? pf : entered.trim();
        },
        validate:
            cred !== null
                ? async (model) => {
                      const s = clackSpinner();
                      s.start(`Validating "${model}" (sends one 1-token test message)`);
                      const outcome = await pingMessagesEndpoint(direct.baseURL, protocol, cred, model);
                      if (outcome.kind === "pass") s.stop(`Model "${model}" validated`);
                      else if (outcome.kind === "model_not_found") s.stop(`The endpoint does not serve "${model}"`);
                      else s.stop("Model validation was inconclusive");
                      return outcome;
                  }
                : null,
        confirmSave: async (model, detail) => {
            log.warn(`Could not confirm the model: ${detail}`);
            return confirm(`Save "${model}" anyway?`);
        },
        writeBoth: (model) => writeAgentModel("conversation", model).andThen(() => writeAgentModel("sandbox", model)),
        warn: (message) => log.warn(message),
        success: (message) => log.success(message),
    });
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
 * Map a recorded connection provider slug back to the account kind that logs into it — the inverse of
 * {@link PROVIDER_SLUG}, and legitimate for the same reason that map is: it connects two CONFIGURED
 * facts (the slug setup recorded at login time, the account kind that recorded it), deriving nothing.
 * Total only over slugs we wrote; anything else (absent, a hand-edited value) yields `undefined` and
 * callers fall back to the interactive chooser / generic wording.
 */
export function providerKindForSlug(slug: string | undefined): Provider | undefined {
    if (!slug) return undefined;
    return PROVIDERS.find((p) => PROVIDER_SLUG[p] === slug);
}

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

/**
 * The one field the presence check may read from a credential file. `disabled` is operator-set
 * (upstream documents it as "intentionally disabled by operator"), so it is a legitimate static
 * signal; everything else in the file is refresh-lifecycle state that must NOT gate presence — in
 * particular `expired`, which goes stale every 8 hours by design while the running proxy refreshes it.
 */
const credentialFileSchema = z.object({ disabled: z.boolean().optional() });

/**
 * Whether a usable provider credential is present in `dir`. Structural only: the vendor also writes a
 * `logs/` subdirectory into the auth dir, so "any non-dot entry" overcounts — only `*.json` entries
 * are credentials. Validity is deliberately NOT judged here: a dead refresh token leaves no trace in
 * the file (the vendor persists no failure state), so the launch-time probe is the sole authority on
 * whether the credential still works. An unreadable or unparseable credential file counts as present
 * for the same reason — refusing it here would lock the user into a re-login the probe could have
 * proven unnecessary.
 */
export async function hasProviderCredential(dir: string): Promise<boolean> {
    // A missing/unreadable dir is the ordinary never-logged-in state — in-band false, not an error.
    const entries = await readdir(dir).then(
        (names) => names,
        () => null,
    );
    if (entries === null) return false;
    for (const name of entries) {
        if (name.startsWith(".") || !name.endsWith(".json")) continue;
        const parsed = await readFile(join(dir, name), "utf8").then(
            (text) => JSON.parseWith(text, credentialFileSchema),
            () => null,
        );
        if (parsed === null || parsed.disabled !== true) return true;
    }
    return false;
}

async function isAuthenticated(): Promise<boolean> {
    return hasProviderCredential(env.cliproxyAuthDir);
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
    // The login container runs the same pinned image as the compose proxy service (PROXY_IMAGE).
    const args = ["run", "--rm", "-i", ...volumeArgs(rt), ...publish, PROXY_IMAGE, CONTAINER_BINARY, PROVIDER_LOGIN_FLAG[provider], "--no-browser"];

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

// --- launch-time credential probe ------------------------------------------
//
// A credential file proves nothing: the provider access token expires every 8 hours and the proxy
// refreshes it with the stored refresh token — when THAT dies (revocation, vendor bug), the file
// looks exactly like a healthy one and every call answers 401. The only honest check is a live
// request, and the cheapest place that prevents the "looks ready, fails mid-work, exit the TUI to
// re-login" trap is the launch gate, where stdio is still normal and the interactive login can run
// inline. cliproxy mode only: a direct connection is the user's own endpoint and key, not ours to
// spend on validation.

/** Bounds each probe request so a wedged proxy can never stall the launch. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * How long a not-yet-answering proxy is retried before its silence is called unreadable, and the pause
 * between tries. The budget is deliberately larger than a container's start latency and smaller than a
 * user's patience; a refused connection costs nothing per try, so the pause is what paces the loop.
 */
const PROXY_BOOT_BUDGET_MS = 10_000;
const PROXY_BOOT_PAUSE_MS = 250;

/**
 * What one probe request observed, as the launch policy sees it. Only `unauthorized` — a definite
 * provider-side 401 — is a credential verdict that may gate; every other kind proceeds. `unobservable`
 * covers everything that is not a verdict — an outage, a timeout, a malformed probe. `cooling_down`,
 * `client_key_drift`, and `empty_at_deadline` are their own honest notices (a proxy cooldown, a config
 * drift between the on-disk client key and the running proxy, and an answering-but-empty proxy the boot
 * budget could not resolve): each proceeds and NONE drives a login, because the fork facts behind each
 * mean a provider re-login is the wrong remedy (see {@link ensureLiveCredential}).
 */
type CredentialProbe =
    | { kind: "ok" }
    | { kind: "unauthorized" }
    | { kind: "unobservable"; detail: string }
    | { kind: "cooling_down" }
    | { kind: "client_key_drift" }
    | { kind: "empty_at_deadline" };

/**
 * One attempt's raw outcome, before {@link retryWhileUnreachable} folds it into a {@link CredentialProbe}.
 * Two kinds are "keep waiting", not verdicts, and both retry under the one boot budget:
 * - `unreachable` — no HTTP answer at all: `compose up`/`restart` return when the ENGINE reports the
 *   container started, not when the proxy has bound its port, so a request right after either can lose
 *   that race and observe a refused connection that says nothing about the credential.
 * - `not_ready` — the proxy answered but its async auth-file registration has not landed, so `/v1/models`
 *   is still empty; this window opens on every cold start, including the bounce the gate itself performs
 *   between a re-login and its re-probe, and an empty list read inside it is a boot artifact, not a verdict.
 */
export type ProbeAttempt = CredentialProbe | { kind: "unreachable"; detail: string } | { kind: "not_ready" };

/**
 * One minimal completion through the proxy to observe whether the provider credential works. This is
 * a real, metered provider request (~1 token) — the accepted per-launch cost of catching a dead
 * credential before work starts. `x-api-key` + `anthropic-version` because the proxy exposes the
 * Anthropic Messages route the chat path targets (see resolveModelConnection: cliproxy has no
 * protocol choice). Exported for its unit tests.
 */
export async function askProxy(apiKey: string, modelId: string): Promise<ProbeAttempt> {
    let res: Response;
    try {
        res = await fetch(`${env.cliproxyApiUrl}/messages`, {
            method: "POST",
            headers: { "x-api-key": apiKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
    } catch (cause) {
        // Refused connection, DNS, or the timeout above — bridge the throw in-band. A timeout lands
        // here too and is retried like any other silence, but it burns the whole per-try bound, so the
        // budget check below ends the loop rather than paying it twice.
        return { kind: "unreachable", detail: cause instanceof Error ? cause.message : String(cause) };
    }
    if (res.status === 401) return { kind: "unauthorized" };
    // A 503 carrying the proxy's `auth_unavailable` marker is the cooldown after upstream errors — every
    // loaded credential is temporarily blocked and recovers on its own, so it is its own notice, never a
    // login prompt. Any other 503 (or an unrecognized body) stays on the generic unobservable path below.
    if (res.status === 503 && (await isProxyCooldown(res))) return { kind: "cooling_down" };
    if (!res.ok) return { kind: "unobservable", detail: `HTTP ${res.status}` };
    return { kind: "ok" };
}

/**
 * Map a model-resolution failure onto a probe attempt. Exported for its unit tests.
 *
 * `resolveModelId` collapses "the proxy never answered" and "the proxy answered with a status" into
 * one `proxy_unreachable` whose `detail` is either `HTTP <status>` or the fetch throw's message, so
 * that prefix is the only discriminator available. The check is kept here rather than widening
 * `ChatSetupError`, because the chat path that owns that type has no use for the distinction.
 */
export function classifyModelResolution(error: ChatSetupError): ProbeAttempt {
    switch (error.type) {
        case "proxy_key_missing":
            return { kind: "unobservable", detail: error.type };
        case "no_models":
            // An empty list is a boot artifact, not a verdict. The proxy's HTTP listener answers before
            // its async auth-file registration lands (verified against the fork and a live proxy), so a
            // cold start — including the bounce the gate itself performs after a re-login — serves an
            // empty `/v1/models` from an otherwise-healthy proxy. It is therefore retried like silence:
            // `retryWhileUnreachable` waits the boot budget for the list to populate, and only a list
            // STILL empty at the deadline becomes the ambiguous (never a login) `empty_at_deadline`.
            return { kind: "not_ready" };
        case "cooling_down":
            // A served 503 whose body carries the proxy's `auth_unavailable` marker: every loaded
            // credential is temporarily blocked after upstream errors and recovers on its own, while the
            // on-disk credential stays valid — its own notice, not a login prompt.
            return { kind: "cooling_down" };
        case "proxy_unreachable":
            // A 401 on the model-listing route is the proxy's client-API-key middleware ALONE — it never
            // consults the provider credential (verified against the fork), so it cannot be a credential
            // verdict. It proves the client key the CLI read from config.yaml is not the one the running
            // proxy loaded (config drift across a boot), which a provider re-login cannot fix; the launch
            // names that condition and `inflexa setup`, and never offers OAuth.
            if (error.detail === "HTTP 401") return { kind: "client_key_drift" };
            return error.detail.startsWith("HTTP ")
                ? { kind: "unobservable", detail: `${error.type}: ${error.detail}` }
                : { kind: "unreachable", detail: error.detail };
        default: {
            const unhandled: never = error;
            throw new Error(`unhandled ChatSetupError: ${JSON.stringify(unhandled)}`);
        }
    }
}

/**
 * Run `attempt` until it reads a verdict the policy can act on, waiting out the proxy's boot window.
 * Every other container path in this module waits for readiness rather than assuming it (see
 * `waitForReady` in postgres.ts); the proxy publishes no health endpoint, so a *readable* answer is the
 * only readiness signal there is, and retrying the probe itself is that wait. Readable means TWO things,
 * and both are retried here under the one budget:
 * - `unreachable` — nothing answered yet (the port is not bound).
 * - `not_ready` — the proxy answers but its auth-file registration has not landed, so `/v1/models` is
 *   still empty. This window opens on every cold start, and crucially on the bounce the gate itself
 *   performs between a re-login and its re-probe — the step whose whole job is confirming the fresh
 *   credential took, running against exactly the cold container its own restart just created. Without
 *   waiting it, an empty list read here would be misread as a credential rejection and force a second,
 *   spurious login.
 *
 * At the deadline the two waits diverge: a proxy that never answered is an outage (`unobservable` — warn
 * and proceed, the status quo), while an answering proxy still serving an empty list is genuinely
 * ambiguous (`empty_at_deadline`) — an unloadable credential file OR a provider-side suspension window,
 * which the gate cannot tell apart and must NOT resolve by forcing a login.
 */
export async function retryWhileUnreachable(
    attempt: () => Promise<ProbeAttempt>,
    budgetMs = PROXY_BOOT_BUDGET_MS,
    pauseMs = PROXY_BOOT_PAUSE_MS,
): Promise<CredentialProbe> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        const outcome = await attempt();
        if (outcome.kind !== "unreachable" && outcome.kind !== "not_ready") return outcome;
        if (Date.now() >= deadline) {
            return outcome.kind === "not_ready" ? { kind: "empty_at_deadline" } : { kind: "unobservable", detail: outcome.detail };
        }
        await Promise.sleep(pauseMs);
    }
}

/**
 * The seams {@link ensureLiveCredential} drives, injectable so the policy matrix is unit-testable
 * without a terminal, a container runtime, or clack. Production assembly: {@link verifyCredentialAtLaunch}.
 */
type LiveCredentialDeps = {
    /** One probe attempt (includes resolving the key/model inputs; a resolution failure is `unobservable`). */
    probe: () => Promise<CredentialProbe>;
    /**
     * Ask the user (reached only after the TTY gate) whether to run the interactive provider login now.
     * The seam exists so the confirm is a testable policy step; false declines and the launch proceeds.
     */
    confirmRelogin: () => Promise<boolean>;
    /** The interactive provider login; resolves true when a credential was (re)established. */
    relogin: () => Promise<boolean>;
    /** Make the fresh credential observable to the RUNNING proxy (see composeRestartProxy). */
    restartProxy: () => Promise<Result<void, { message: string }>>;
    isInteractive: () => boolean;
    /** Tell the user why the launch is about to offer an interactive login — a notice, not a fault. */
    announce: (message: string) => void;
    warn: (message: string) => void;
};

/**
 * Report a non-gating probe outcome and proceed — every {@link CredentialProbe} kind except
 * `unauthorized` lands here, so it is typed to exclude that one and the compiler proves the switch
 * exhaustive. `ok` is silent; each other kind prints its own honest line (a proxy cooldown, a client-key
 * config drift, an answering-but-empty proxy the boot budget could not resolve, or a generic unobservable
 * fault) and NONE drives a login: the fork facts behind each mean a provider re-login is the wrong remedy.
 * `afterRelogin` only tunes the `unobservable` wording (before vs after the re-login cycle).
 */
function reportNonVerdict(
    outcome: Exclude<CredentialProbe, { kind: "unauthorized" }>,
    deps: LiveCredentialDeps,
    afterRelogin: boolean,
): Result<void, ProxyError> {
    switch (outcome.kind) {
        case "ok":
            return ok(undefined);
        case "unobservable":
            deps.warn(
                afterRelogin
                    ? `Could not verify the provider login after re-authenticating (${outcome.detail}) — continuing.`
                    : `Could not verify the provider login (${outcome.detail}) — continuing; chat will surface any real failure.`,
            );
            return ok(undefined);
        case "cooling_down":
            // Cooldown, not a dead credential: the proxy is briefly refusing every loaded credential after
            // upstream errors and recovers on its own, so a re-login would churn a healthy credential for
            // nothing. Report and proceed.
            deps.warn(
                "Your provider credential is cooling down after upstream errors — the proxy is briefly refusing it and will recover on its own.\n  Continuing; retry if chat calls fail.",
            );
            return ok(undefined);
        case "client_key_drift":
            // The `/v1/models` 401 came from the proxy's client-API-key middleware, never the provider
            // credential, so OAuth cannot fix it — name the real fault (the on-disk client key drifted from
            // the running proxy) and the remedy that can (`inflexa setup` reprovisions/restarts).
            deps.warn(
                `The proxy rejected the client key: the key in ${env.cliproxyConfigPath} no longer matches the running proxy (config drift across a restart), which a provider re-login cannot fix.\n  Re-run \`inflexa setup\` to reprovision, then relaunch. Continuing.`,
            );
            return ok(undefined);
        case "empty_at_deadline":
            // Ambiguous, not dead: the proxy answered but listed no models for the whole boot budget. The
            // gate cannot tell an unloadable credential file apart from a provider-side suspension window
            // (the on-disk credential stays valid through the latter), so it names both causes and the
            // re-login remedy but drives no login itself — chat's auth banner is the backstop.
            deps.warn(
                "The proxy is answering but lists no models. Either it could not load your credential file, or the provider has temporarily suspended the account's models (which recovers on its own).\n  If chat keeps failing, re-run `inflexa setup --provider <name>` to sign in again. Continuing.",
            );
            return ok(undefined);
        default: {
            const unhandled: never = outcome;
            throw new Error(`unhandled CredentialProbe: ${JSON.stringify(unhandled)}`);
        }
    }
}

/**
 * The launch-gate credential policy: only a definite provider-side 401 (`unauthorized`) gates. Every
 * other outcome — cooldown, client-key drift, empty-at-deadline, or any unobservable fault — proceeds via
 * {@link reportNonVerdict} without a login. On a TTY the rejection now OFFERS a re-login (a confirm, not
 * an imposition): declining warns and proceeds (chat's auth mapping is the backstop), while accepting
 * drives one re-login → proxy restart → re-probe cycle. That re-probe goes through the same `deps.probe`
 * seam — which in production wraps {@link retryWhileUnreachable} — so the freshly bounced (always-cold)
 * container's registration window is waited out, never raced into a spurious failure. A second definite
 * 401 fails hard naming BOTH remaining causes, because looping the login again cannot distinguish them.
 */
export async function ensureLiveCredential(deps: LiveCredentialDeps): Promise<Result<void, ProxyError>> {
    const first = await deps.probe();
    if (first.kind !== "unauthorized") return reportNonVerdict(first, deps, false);

    if (!deps.isInteractive()) {
        return err(new ProxyError("The provider login has expired or been revoked.\n  Run `inflexa setup --provider <name>` to sign in again."));
    }

    // Offer, don't impose: forcing OAuth on every 401 was the daily churn users hit, and the user may
    // already have fixed the account elsewhere. Declining proceeds to launch, where chat's auth banner
    // names the remedy on the first real failure.
    deps.announce("Your provider login looks expired or revoked.");
    if (!(await deps.confirmRelogin())) {
        deps.warn("Continuing without re-login — provider calls will fail until you sign in again (`inflexa setup --provider <name>`).");
        return ok(undefined);
    }

    if (!(await deps.relogin())) {
        return err(new ProxyError("Re-authentication didn't complete.\n  Run `inflexa setup --provider <name>` to sign in, then try again."));
    }
    const restarted = await deps.restartProxy();
    if (restarted.isErr()) {
        return err(new ProxyError(`Could not restart the proxy to pick up the fresh login: ${restarted.error.message}`));
    }

    const second = await deps.probe();
    if (second.kind !== "unauthorized") return reportNonVerdict(second, deps, true);
    return err(
        new ProxyError(
            `Still unauthorized after re-authenticating. Either the sign-in did not take, or the client key in ${env.cliproxyConfigPath} no longer matches the proxy.\n  Re-run \`inflexa setup\` to reprovision.`,
        ),
    );
}

/**
 * One full probe attempt: resolve the inputs from the provisioned config and the proxy's own model
 * list, then ask. Both round-trips are bounded, so {@link retryWhileUnreachable}'s budget bounds the
 * whole loop — an unbounded one would hand a wedged proxy the launch indefinitely. The election lives
 * inside {@link resolveModelId}, so this inherits it with no adaptation: a top-ranked candidate the
 * credential cannot serve is walked past there, and this probes a model already known to be servable.
 * Exported for its integration test.
 */
export async function probeOnce(): Promise<ProbeAttempt> {
    const key = await readApiKey();
    if (key.isErr()) return { kind: "unobservable", detail: key.error.type };
    const model = await resolveModelId(key.value, AbortSignal.timeout(PROBE_TIMEOUT_MS));
    return model.isErr() ? classifyModelResolution(model.error) : askProxy(key.value, model.value);
}

/**
 * Production assembly of {@link ensureLiveCredential}: probe (retrying a proxy that is not answering
 * yet), pre-select the re-login account from the recorded provider slug, and restart the proxy after a
 * re-login. A spinner frames each probe so the launch shows why it is pausing for ~a second.
 */
async function verifyCredentialAtLaunch(rt: ContainerRuntime): Promise<Result<void, ProxyError>> {
    return ensureLiveCredential({
        probe: async () => {
            const s = clackSpinner();
            s.start("Verifying provider login");
            const outcome = await retryWhileUnreachable(probeOnce);
            if (outcome.kind === "ok") s.stop("Provider login verified");
            else if (outcome.kind === "unauthorized") s.stop("Provider login expired or revoked");
            else if (outcome.kind === "cooling_down") s.stop("Provider credential cooling down");
            else if (outcome.kind === "client_key_drift") s.stop("Proxy client key mismatch");
            else s.stop("Provider login not verifiable");
            return outcome;
        },
        // The clack confirm (lib/cli.ts) matches the surrounding setup prompt idiom; it is reached only on
        // the TTY path, so its non-TTY stdin-drain branch never runs here. Declining is the consenting "no".
        confirmRelogin: () => confirm("Sign in to the provider again now? Declining continues to the app — provider calls will fail until you sign in."),
        relogin: () => authenticate(rt, providerKindForSlug(resolveModelConnection().provider)),
        restartProxy: () => composeRestartProxy(rt),
        isInteractive: () => Boolean(process.stdin.isTTY),
        // Printed, not logged: this lands in the normal-stdio launch phase right before the confirm
        // prompt takes the terminal, beside ensureProxyReady's own fresh-login notice.
        announce: (message) => console.log(`\n  ${message}`),
        warn: (message) => log.warn(message),
    });
}

// --- stale explicit-pin warning --------------------------------------------
//
// The credential probe above validates only the AUTO default (election walks it against the live
// credential). An EXPLICIT pin — `models.agents.*`, or the both-agents `harness.model` fallback — is
// what chat actually runs on, yet the probe never touches it: it resolves the auto default, not the
// per-agent id. So a pin that has gone stale (the account no longer serves it) sails past launch and
// only fails mid-chat. This gate closes that gap: it names the stale pin at launch, where stdio is
// still normal, without ever blocking the launch or rewriting the user's config.

/**
 * The seams {@link warnStalePins} drives, injectable so the pin→agent grouping and the verdict→warning
 * policy are unit-testable without a proxy, a container, or a real config. Production assembly:
 * {@link warnStalePinsAtLaunch}.
 */
type StalePinDeps = {
    /** The resolved connection — its `mode`/`provider` gate the check and its `agents` carry the per-agent pins. */
    connection: ResolvedModelConnection;
    /** The both-agents fallback pin (`harness.model`, i.e. `cfg.model`); `null` when unset. */
    modelPin: string | null;
    /** One model's accessibility check, bounded like every probe round-trip. */
    check: (modelId: string) => Promise<ModelAccess>;
    warn: (message: string) => void;
};

/**
 * Warn — never block — when an explicitly-pinned model has gone stale. Applies ONLY in cliproxy mode on
 * an anthropic-family connection (the `count_tokens` route is Anthropic-protocol, and a direct or
 * non-anthropic endpoint is not ours to spend on validation — the same gate the launch probe uses) and
 * ONLY when at least one explicit pin exists; an auto-resolved session (no pins) is untouched, because
 * the election already validated its default. Each DISTINCT pinned id is checked exactly once, and only a
 * definite `not_found` warns — `served`/`inconclusive` stay silent (a flaky check must not interrupt the
 * launch output). Returns nothing on every path: this can only add a line, never a failure.
 */
export async function warnStalePins(deps: StalePinDeps): Promise<void> {
    if (deps.connection.mode !== "cliproxy" || deps.connection.provider !== "anthropic") return;

    // Each agent's EFFECTIVE explicit pin is its own `models.agents` override, else the both-agents
    // `harness.model` fallback; an agent with neither is auto-resolved and skipped. Grouping by the
    // resolved id means a `harness.model` pin shared by both agents is one round-trip and one warning
    // naming both, while an agent override that redirects one of them splits into its own distinct pin.
    const byId = new Map<string, AgentName[]>();
    for (const agent of AGENT_NAMES) {
        const pin = deps.connection.agents[agent] ?? deps.modelPin ?? undefined;
        if (pin === undefined) continue;
        byId.set(pin, [...(byId.get(pin) ?? []), agent]);
    }
    if (byId.size === 0) return;

    for (const [modelId, agents] of byId) {
        if ((await deps.check(modelId)) !== "not_found") continue;
        deps.warn(stalePinWarning(modelId, agents));
    }
}

/**
 * The launch warning for one stale pin: the pinned id, which agent(s) resolve to it, and the two repick
 * remedies. The agents are named explicitly and pluralized from the list's own length, so the phrasing
 * stays correct whether one agent is pinned or several share a `harness.model` fallback — with no coupling
 * to how many user-facing agents exist.
 */
function stalePinWarning(modelId: string, agents: AgentName[]): string {
    const who = `the ${agents.join(" and ")} agent${agents.length > 1 ? "s" : ""}`;
    return (
        `The pinned model "${modelId}" (${who}) is no longer served by your account.\n` +
        "  Repick it with the model-switch commands in the command palette, or re-run `inflexa setup`."
    );
}

/**
 * Production assembly of {@link warnStalePins}: read the proxy client key, then bound each accessibility
 * check with the same per-round-trip timeout the probe uses. A missing key needs no warning — the probe
 * above already surfaced it as `unobservable`, and there is nothing to check against.
 */
async function warnStalePinsAtLaunch(): Promise<void> {
    const key = await readApiKey();
    if (key.isErr()) return;
    await warnStalePins({
        connection: resolveModelConnection(),
        modelPin: resolveHarnessConfig().model,
        check: (modelId) => checkModelAccess(key.value, modelId, AbortSignal.timeout(PROBE_TIMEOUT_MS)),
        warn: (message) => log.warn(message),
    });
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
    let proxyPredatesLogin = false;
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
            // The login just rewrote the auth dir, but a proxy container from an earlier session may
            // still be serving without having loaded it — host writes to the mounted auth dir never
            // reach its file watcher, and composeUp below will not bounce a running container. A
            // proxy composeUp starts COLD reads the fresh file at boot and needs nothing, so only a
            // pre-existing container must be restarted — after composeUp, which is where the compose
            // file for this run has been regenerated (composeRestartProxy's contract). An
            // unanswerable engine skips the bounce: the probe below still reads the truth and can
            // recover interactively.
            proxyPredatesLogin = (await composeProxyRunning(rt)).unwrapOr(false);
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

    // The static check above only proved a credential FILE exists; whether the provider still honors
    // it is observable only by asking (a dead refresh token leaves no trace on disk). After composeUp
    // so the probe has a serving proxy; cliproxy mode only — a direct connection is the user's own
    // endpoint and key, never probed.
    if (mode === "cliproxy") {
        if (proxyPredatesLogin) {
            // Without this bounce the probe below would read the pre-login emptiness, call the
            // credential rejected, and drive a SECOND login the user's first one already earned.
            const restarted = await composeRestartProxy(rt);
            if (restarted.isErr()) {
                return err(new ProxyError(`Could not restart the proxy to pick up the fresh login: ${restarted.error.message}`));
            }
        }
        const live = await verifyCredentialAtLaunch(rt);
        if (live.isErr()) return err(live.error);

        // The probe validated only the AUTO default; the pins chat actually runs on are checked here,
        // after the credential is confirmed live and the proxy is answering (so count_tokens reads a real
        // verdict, not a cold-boot silence). Warn-only — it never gates the launch it just cleared.
        await warnStalePinsAtLaunch();
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
