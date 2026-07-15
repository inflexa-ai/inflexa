import { existsSync, lstatSync } from "node:fs";
import { ok, err, type Result } from "neverthrow";
import {
    bootHarness,
    createConfiguredAiSdkProvider,
    createDbosRunLauncher,
    createLocalRunAuthorizer,
    createNoopBillingResolver,
    createPool,
    createSandboxClient,
    createWorkspaceFilesystem,
    makeLocalAuth,
    queryActiveSandboxes,
    registerNotificationSweep,
    registerSandboxReaper,
    registerWatchdog,
    sweepEphemeralWorkflows,
    UnavailablePreviewPublisher,
    type AgentDefinition,
    type AgentSession,
    type AiSdkProviderConfig,
    type ChatProvider,
    type ConversationAssemblyDeps,
    type CoreWorkflowDeps,
    type DataProfileTriggerDeps,
    type EmbeddingProvider,
    type ExecuteAnalysisInput,
    type ExecuteAnalysisResult,
    type MachineBudget,
    type Pool,
    type RegisterNotificationSweepDeps,
    type RegisterReaperDeps,
    type RunAuthorizer,
    type RunLauncher,
    type WatchdogDeps,
} from "@inflexa-ai/harness";

import { readConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { acquireInstanceLock, releaseInstanceLock } from "../../lib/lock.ts";
import { getLogger } from "../../lib/log.ts";
import { onShutdown } from "../../lib/shutdown.ts";
import { workspaceRootForAnalysisId } from "../analysis/output.ts";
import { resolveEmbedder, type EmbeddingResolveError } from "../embedding/resolve.ts";
import { ensurePostgresReady } from "../infra/postgres.ts";
import type { PostgresConnection, PostgresError } from "../infra/postgres_types.ts";
import { modelMatchesProvider, readApiKey, resolveModelId, type ChatSetupError } from "../proxy/models.ts";
import {
    resolveHarnessConfig,
    resolveModelConnection,
    AGENT_NAMES,
    type ResolvedHarnessConfig,
    type ResolvedModelConnection,
    type AgentName,
    type ModelConnectionIdentity,
} from "./config.ts";
// Type-only: erased at compile, so it does NOT pull content.ts (and its embedded pack) into the module
// graph. The value import is the release-gated dynamic `import("./content.ts")` in the boot body below.
import type { ContentError } from "./content.ts";
import { noopExecIngress, startExecIngress, type ExecIngress, type IngressError } from "./ingress.ts";
import { createSwappableSandboxEmitters } from "./prov_bridge.ts";
import {
    buildEphemeralDeps,
    buildExecuteAnalysisDeps,
    buildExecuteTargetAssessmentDeps,
    buildSandboxStepDeps,
    type RunEngineComposition,
    type AgentBackend,
} from "./run_deps.ts";
import { clearAgentSwitch, createSwappableProvider, installAgentSwitch } from "./agent_switch.ts";

/**
 * Return the reference-store bind source only when it already exists. This existence gate is
 * deliberately pure/injectable so runtime boot never asks Docker to create a missing host path.
 */
export function existingRefStorePath(path: string, isDirectory: (candidate: string) => boolean = existingDirectory): string | undefined {
    return isDirectory(path) ? path : undefined;
}

/** Build the optional sandbox-client reference mount fragment, omitting a missing source entirely. */
export function existingRefStoreConfig(path: string, isDirectory: (candidate: string) => boolean = existingDirectory): { readonly refStorePath?: string } {
    const refStorePath = existingRefStorePath(path, isDirectory);
    return refStorePath === undefined ? {} : { refStorePath };
}

function existingDirectory(path: string): boolean {
    try {
        // Reject symlinks as bind authorities: the configured path should itself be the deliberately
        // created public store, not an indirection that may later move outside user expectations.
        return lstatSync(path).isDirectory();
    } catch {
        return false;
    }
}

// The embedded-harness composition root. Boots lazily on the first profile
// trigger (never from a passive flow — no-litter policy) and holds a process
// singleton: workflow deps are closed over at registration and DBOS forbids
// re-registering a name, so there is exactly one runtime per process, one
// workspace-root resolver, one registration cohort.
//
// The ordered, effectful tail of boot — validate skills → init state → assert
// the connection budget → assemble the workflow cohort → run the embedder's
// pre-launch hook → launch DBOS — is the harness's own `bootHarness`. This root
// resolves the host-specific inputs (Postgres, providers, models, ingress, the
// instance lock) and hands them to `bootHarness`, which owns the sequencing
// invariant: registration happens BEFORE `launchDbos`, because `DBOS.launch()`
// runs recovery synchronously and resolves in-flight workflows by their
// registered name, so a workflow not registered at launch cannot be reclaimed.
// The CLI's host-specific pre-launch work (the ephemeral sweep, the agent-switch
// install, the sandbox-hygiene crons) rides `bootHarness`'s `beforeLaunch` hook,
// which runs after registration and before launch.

/**
 * Ready-to-use deps for the analysis-run trigger flow (`inflexa run`). Mirrors
 * {@link DataProfileTriggerDeps}: it carries the pool (dedup pre-check, run
 * reservation, and status ledger reads), the registered parent workflow, the
 * DBOS launch seam, and the run-authorization seam — everything the replicated
 * `executePlan` flow needs, and nothing that would require it to reach into the
 * durability engine directly.
 */
export type RunTriggerDeps = {
    /** App pool — dedup pre-check, run reservation, status/step ledger reads. */
    readonly pool: Pool;
    /** The registered `executeAnalysis` parent workflow — launched under `workflowId = runId`. */
    readonly executeAnalysis: (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult>;
    /** DBOS launch seam — starts `executeAnalysis` fire-and-forget under the caller-chosen run id. */
    readonly runLauncher: RunLauncher;
    /** Local run-authorization seam — mints/revokes the durable `RunSession` at the async edge. */
    readonly runAuthorizer: RunAuthorizer;
    /**
     * The harness machine budget (`resourcePolicy.budget`), supplied on every
     * launched run's `ExecuteAnalysisInput` — its meaning and enforcement are
     * the harness's contract.
     */
    readonly budget: MachineBudget;
};

/** The booted runtime — everything the launch command needs to trigger and observe runs. */
export type HarnessRuntime = {
    /**
     * The conversation agent's backend — the model id + chat-provider instance the `chat`/TUI path
     * drives. `chat` passes {@link AgentBackend.provider} to `runAgent`
     * without re-resolving the model or key; the boot store surfaces {@link AgentBackend.model}.
     */
    readonly conversation: AgentBackend;
    /**
     * The sandbox agent's backend — the model id + chat-provider instance the run engine (step agents,
     * data profile, ephemeral runner) drives. Referentially identical to {@link
     * HarnessRuntime.conversation} when both agents resolve to the same model (one provider instance).
     */
    readonly sandbox: AgentBackend;
    /** App pool over the provisioned Postgres — shared with the harness ledger queries. */
    readonly pool: Pool;
    /** Ready-to-use deps for `triggerDataProfile`. */
    readonly triggerDeps: DataProfileTriggerDeps;
    /** Ready-to-use deps for the analysis-run trigger flow. */
    readonly runTriggerDeps: RunTriggerDeps;
    /**
     * The assembled conversation `AgentDefinition` — the `chat` command drives it
     * with {@link HarnessRuntime.conversation}'s provider via `runAgent`. Built by
     * `assembleCoreRuntime` over the same registered workflow callables the
     * trigger deps expose, so its `execute_plan` tool launches the identical
     * `executeAnalysis` parent.
     */
    readonly conversationAgent: AgentDefinition;
    /**
     * The shared connection's identity (provider slug + mode) the runtime booted on — the fact the TUI
     * status surface renders beside the per-agent models. Stamped once
     * at boot from the resolved connection and never changed by a live agent-model swap (the connection
     * is shared across agents, so a swap changes only a model), so the boot store can seed it a single
     * time at the ready edge.
     */
    readonly connection: ModelConnectionIdentity;
    readonly ingress: ExecIngress;
};

/** Why the runtime could not boot — each variant maps to one actionable user message. */
export type HarnessBootError =
    | { type: "harness_config_invalid"; issues: string }
    | { type: "model_connection_invalid"; issues: string }
    | { type: "embedding_unresolved"; cause: EmbeddingResolveError }
    | { type: "embedding_probe_failed"; detail: string }
    | { type: "embedding_dimension_mismatch"; expected: number; actual: number }
    | { type: "content_materialize_failed"; cause: ContentError }
    | { type: "skills_dir_missing"; path: string | null }
    | { type: "templates_dir_missing"; path: string | null }
    | { type: "proxy_key_missing"; cause: ChatSetupError }
    | { type: "model_api_key_missing" }
    | { type: "model_unresolved"; cause: ChatSetupError }
    | { type: "model_provider_mismatch"; provider: string; model: string }
    | { type: "model_required"; agents: readonly AgentName[] }
    | { type: "postgres_unavailable"; cause: PostgresError }
    | { type: "ingress_failed"; cause: IngressError }
    | { type: "runtime_already_active"; holderPid: number }
    | { type: "runtime_boot_failed"; cause: unknown };

/** Why the embedding probe failed — a failed/hung embed call vs. a working-but-wrong-width model. */
export type EmbeddingProbeError = { kind: "embed_failed"; detail: string } | { kind: "dimension_mismatch"; expected: number; actual: number };

/** Ceiling on the probe embed. Generous for both realizations: an endpoint round-trip and the local GGUF's one-time model load. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Boot-time probe of the resolved embedder. Embeddings are consumed LATE in
 * the profile workflow — after the sandbox agent already spent its LLM budget —
 * and a broken embedder AND a wrong-width model are both fatal there: the
 * per-analysis pgvector index is sized to `provider.dimensions`, so vectors of
 * any other width are rejected at the upsert. One real embed up front converts
 * both expensive late failures into free early ones.
 *
 * The probe goes through the very provider instance the workflow will use —
 * mode-agnostic by construction: for `api-key` it is the real endpoint
 * round-trip; for `local` it loads the GGUF and warms the provider's cached
 * runtime (same process), so the cost is not wasted.
 */
async function probeEmbeddingProvider(provider: EmbeddingProvider): Promise<Result<void, EmbeddingProbeError>> {
    // A minimal local session: the probe is identity-less work and the wired
    // billing resolver is the noop one, but the seam (correctly) refuses calls
    // without a session.
    const probeSession: AgentSession = {
        identity: { user: "local" },
        scope: { kind: "analysis", analysisId: "embedding-boot-probe" },
        provenance: { agentId: "embedding-boot-probe", callPath: ["embedding-boot-probe"] },
        auth: makeLocalAuth(),
    };
    const checked: Promise<Result<void, EmbeddingProbeError>> = provider.embed(["ping"], probeSession).match(
        (vectors): Result<void, EmbeddingProbeError> => {
            const actual = vectors[0]?.length ?? 0;
            return actual === provider.dimensions ? ok(undefined) : err({ kind: "dimension_mismatch", expected: provider.dimensions, actual });
        },
        (e): Result<void, EmbeddingProbeError> => err({ kind: "embed_failed", detail: e.message }),
    );
    // `EmbeddingProvider.embed` takes no AbortSignal, so a hung call can only be
    // raced, not cancelled — the loser is abandoned, which is fine at boot: on
    // timeout we fail the boot, and on success the process runs long past it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS);
    });
    const outcome = await Promise.race([checked, timeout]);
    clearTimeout(timer);
    if (outcome === "timeout") {
        return err({ kind: "embed_failed", detail: `no embedding after ${PROBE_TIMEOUT_MS / 1000}s` });
    }
    return outcome;
}

/**
 * The boot sequence's effectful seams, injectable so the sequencing test runs
 * offline (no Postgres, no proxy, no DBOS). Production callers pass nothing.
 */
export type BootSeams = {
    readonly ensurePostgres: () => Promise<Result<PostgresConnection, PostgresError>>;
    readonly startIngress: () => Result<ExecIngress, IngressError>;
    readonly readKey: () => Promise<Result<string, ChatSetupError>>;
    /** The `direct`-connection secret from the environment (`env.modelApiKey`); `undefined` when unset. */
    readonly readModelApiKey: () => string | undefined;
    readonly resolveModel: (apiKey: string) => Promise<Result<string, ChatSetupError>>;
    readonly resolveEmbedding: () => Result<EmbeddingProvider, EmbeddingResolveError>;
    /**
     * The harness-owned boot sequence: validate skills → init state → assert the
     * connection budget → `assembleCoreRuntime` (child-before-parent registration
     * of all five durable workflows) → the embedder's `beforeLaunch` hook →
     * launch DBOS; returns a `{ runtime, shutdown }` handle. The register-before-
     * launch ordering invariant lives in the harness, not here — this root only
     * supplies the deps and the pre-launch hook.
     */
    readonly boot: typeof bootHarness;
    /**
     * Cancel this executor's PENDING `ephemeral:*` rows BEFORE launch, run inside
     * `bootHarness`'s `beforeLaunch` hook. Registering the ephemeral workflow (in
     * the assemble step) makes a crashed turn's row re-dispatchable by launch-time
     * recovery; the only race-free cancel point is a direct system-DB UPDATE that
     * completes before launch — which `beforeLaunch` guarantees.
     */
    readonly sweepEphemeral: typeof sweepEphemeralWorkflows;
    /** Register the orphaned-container reaper scheduled workflow. */
    readonly registerReaper: (deps: RegisterReaperDeps) => void;
    /** Register the dead-sandbox liveness watchdog scheduled workflow. */
    readonly registerWatchdog: (deps: WatchdogDeps) => void;
    /** Register the stale-notification sweep scheduled workflow. */
    readonly registerNotificationSweep: (deps: RegisterNotificationSweepDeps) => void;
    readonly probeEmbedding: typeof probeEmbeddingProvider;
};

const realSeams: BootSeams = {
    ensurePostgres: ensurePostgresReady,
    startIngress: () => startExecIngress(),
    readKey: readApiKey,
    readModelApiKey: () => env.modelApiKey,
    resolveModel: resolveModelId,
    resolveEmbedding: () => resolveEmbedder(readConfig()),
    boot: bootHarness,
    sweepEphemeral: sweepEphemeralWorkflows,
    registerReaper: registerSandboxReaper,
    registerWatchdog,
    registerNotificationSweep,
    probeEmbedding: probeEmbeddingProvider,
};

/**
 * Advisory-lock key for the embedded runtime (see `lib/lock.ts`). A fixed
 * sentinel — not an analysis id — because the lock guards the single per-machine
 * DBOS engine (executor "local"), not any one analysis. Never collides with an
 * analysis lock: analysis ids are UUIDv7.
 */
const RUNTIME_LOCK_KEY = "harness-runtime";

/**
 * Result transport for local sandboxes. The CLI is a poll-mode embedder: the
 * host polls the sandbox for results, so the sandbox needs no egress and no
 * callback ingress (dissolving #27/#41 locally). Callback mode is a managed-
 * embedder concern; flip this only to exercise that path locally.
 */
const SANDBOX_TRANSPORT: "poll" | "callback" = "poll";

let active: HarnessRuntime | null = null;

// The in-flight boot, memoized so concurrent same-process callers share ONE attempt. `active` only
// covers a COMPLETED boot; this covers the window between the first call and that completion.
let booting: Promise<Result<HarnessRuntime, HarnessBootError>> | null = null;

/** The booted runtime, if any — passive callers (status views) may read, never boot. */
export function activeHarnessRuntime(): HarnessRuntime | null {
    return active;
}

/** Test hook: drop the singleton without shutting anything down. Test-only. */
export function __resetHarnessRuntimeForTest(): void {
    active = null;
    booting = null;
    // Detach any switch controller a prior boot test installed, so its bus subscription + gauge state do
    // not leak into the next test.
    clearAgentSwitch();
}

/**
 * Boot (or return) the embedded harness runtime. Idempotent per process, guarded on two levels: a
 * COMPLETED boot short-circuits on {@link active}; an IN-FLIGHT boot is memoized on `booting` so
 * overlapping same-process callers share the one attempt (its registration cohort and its lock
 * acquisition) rather than racing a second DBOS registration. `booting` clears when the attempt settles
 * — a success is thereafter served by `active`, a failure is free to retry. The heavy lifting lives in
 * {@link bootHarnessRuntimeOnce}.
 */
export function bootHarnessRuntime(
    options: { seams?: Partial<BootSeams>; config?: ResolvedHarnessConfig; connection?: ResolvedModelConnection } = {},
): Promise<Result<HarnessRuntime, HarnessBootError>> {
    if (active) return Promise.resolve(ok(active));
    if (booting) return booting;
    const attempt = bootHarnessRuntimeOnce(
        { ...realSeams, ...options.seams },
        options.config ?? resolveHarnessConfig(),
        options.connection ?? resolveModelConnection(),
    );
    booting = attempt;
    void attempt.finally(() => {
        booting = null;
    });
    return attempt;
}

/**
 * One boot attempt, run under the {@link bootHarnessRuntime} in-flight guard.
 * This root resolves the host-specific inputs — prerequisites → Postgres
 * readiness → callback ingress → providers/models → instance lock → pool — then
 * hands them to the harness's `bootHarness` (via the `boot` seam), which owns the
 * ordered tail: validate skills → init state → connection budget → assemble the
 * cohort → the embedder's `beforeLaunch` hook (ephemeral sweep, agent-switch
 * install, sandbox-hygiene crons) → DBOS launch. The shutdown hook is registered
 * once, on success, and drives the boot handle's graceful-shutdown sequence.
 */
async function bootHarnessRuntimeOnce(
    seams: BootSeams,
    cfg: ResolvedHarnessConfig,
    connection: ResolvedModelConnection,
): Promise<Result<HarnessRuntime, HarnessBootError>> {
    const logger = getLogger("harness");

    // A `harness` config block that was present but failed validation: report the
    // offending fields, not a misleading downstream error. Checked first so a bad
    // `adminPort` type never surfaces as "embedding not configured".
    if (cfg.configError) return err({ type: "harness_config_invalid", issues: cfg.configError.issues });
    // Likewise a malformed `models.connection` block: report it rather than booting
    // against the silently-substituted default connection.
    if (connection.configError) return err({ type: "model_connection_invalid", issues: connection.configError.issues });

    // A release binary ships skills/templates embedded, not on disk: materialize them (idempotent) to
    // the hash-keyed content dir that cfg.skillsDir/templatesDir already resolve to in a release build,
    // BEFORE the prerequisite gates below, so those gates find a populated tree. Gated to release — a dev
    // run resolves both to the repo checkout and must not touch the embedded archive. The dynamic import
    // keeps content.ts (and its embedded pack, absent from a dev checkout) out of a dev module graph.
    if (!env.isDevelopment) {
        const { ensureBundledContent } = await import("./content.ts");
        const materialized = ensureBundledContent();
        if (materialized.isErr()) return err({ type: "content_materialize_failed", cause: materialized.error });
    }

    // Prerequisites that no amount of booting can heal — checked before any
    // side effect so a misconfigured run costs nothing. The embedder comes from
    // the top-level `embedding` config key (the single embedding surface,
    // written by `inflexa setup --embeddings`), never from the chat proxy: the
    // proxy fronts OAuth chat providers and serves no embeddings route.
    if (cfg.skillsDir === null || !existsSync(cfg.skillsDir)) {
        return err({ type: "skills_dir_missing", path: cfg.skillsDir });
    }
    // Templates are the conversation agent's second unconditional prerequisite:
    // `submit_report` joins `report-html` under this tree. Gated here, beside
    // skills, so a missing tree fails free before any side effect (mirrors the
    // skills gate exactly — `cfg.templatesDir` is non-null past this point).
    if (cfg.templatesDir === null || !existsSync(cfg.templatesDir)) {
        return err({ type: "templates_dir_missing", path: cfg.templatesDir });
    }
    const embedderResult = seams.resolveEmbedding();
    if (embedderResult.isErr()) return err({ type: "embedding_unresolved", cause: embedderResult.error });
    const embedding = embedderResult.value;

    // The chat credential is mode-specific: cliproxy discovers the
    // minted proxy client key (and contacts the proxy for auto-resolve below);
    // direct reads the env secret and NEVER touches the proxy. Resolved before the
    // probe so a missing credential fails as cheaply as the proxy-key path always did.
    let providerApiKey: string;
    if (connection.mode === "cliproxy") {
        const keyResult = await seams.readKey();
        if (keyResult.isErr()) return err({ type: "proxy_key_missing", cause: keyResult.error });
        providerApiKey = keyResult.value;
    } else {
        const key = seams.readModelApiKey();
        if (!key) return err({ type: "model_api_key_missing" });
        providerApiKey = key;
    }

    // Probe the resolved embedder before anything expensive: embeddings are
    // consumed LATE in the profile workflow (after the sandbox agent spent its
    // LLM budget) and a broken embedder is fatal there, so one real embed is
    // verified while failure is still free.
    const probeResult = await seams.probeEmbedding(embedding);
    if (probeResult.isErr()) {
        const e = probeResult.error;
        return e.kind === "dimension_mismatch"
            ? err({ type: "embedding_dimension_mismatch", expected: e.expected, actual: e.actual })
            : err({ type: "embedding_probe_failed", detail: e.detail });
    }

    // Per-agent model resolution. Each user-facing agent resolves in order:
    // `models.agents.<agent>` → `harness.model` (legacy both-agents fallback) → the connection's mode
    // default. cliproxy's default is the proxy's auto-resolved id (the `/models` ranking); direct has
    // no default, so an agent left with nothing fails boot — the agents that reached this are trusted to
    // resolve, so the failure is enumerated up front (below) rather than mid-loop.
    //
    // The cliproxy auto-default is memoized: when BOTH agents fall through to it (the common no-`agents`
    // config), the proxy's `/models` is hit ONCE and the provider-family guard runs once. The guard
    // applies ONLY to that auto-resolved id — an explicit agent override or `harness.model` is trusted
    // (it may be a proxy alias resolving to the right family), exactly as the pre-agents path trusted an
    // explicit `harness.model`. `modelMatchesProvider` reads the family table provider→family ONLY (a
    // sanity check, never id→provider identity); with the default provider `anthropic` only Claude-family
    // ids pass.
    // Memoize the PROMISE so two agents falling through to the default share ONE `/models` fetch and one
    // family-guard evaluation — even when they resolve concurrently. `.match` consumes the resolve
    // Result and maps both arms back to a boot Result.
    let cliproxyAutoDefault: Promise<Result<string, HarnessBootError>> | null = null;
    const resolveDefaultModel = (): Promise<Result<string, HarnessBootError>> => {
        if (cliproxyAutoDefault !== null) return cliproxyAutoDefault;
        cliproxyAutoDefault = seams.resolveModel(providerApiKey).then((resolved) =>
            resolved.match(
                (m): Result<string, HarnessBootError> =>
                    modelMatchesProvider(connection.provider, m) ? ok(m) : err({ type: "model_provider_mismatch", provider: connection.provider, model: m }),
                (e): Result<string, HarnessBootError> => err({ type: "model_unresolved", cause: e }),
            ),
        );
        return cliproxyAutoDefault;
    };

    // Direct mode has no auto-default: any agent lacking BOTH its own override and `harness.model` is
    // unresolvable. Enumerate them into ONE actionable `model_required` naming every failing agent,
    // before touching the proxy — direct users name the model their endpoint serves.
    if (connection.mode === "direct") {
        const unresolved = AGENT_NAMES.filter((agent) => connection.agents[agent] === undefined && cfg.model === null);
        if (unresolved.length > 0) return err({ type: "model_required", agents: unresolved });
    }

    const resolveAgentModel = async (agent: AgentName): Promise<Result<string, HarnessBootError>> => {
        const override = connection.agents[agent];
        if (override !== undefined) return ok(override);
        if (cfg.model !== null) return ok(cfg.model);
        // cliproxy only past the direct-mode guard above.
        return resolveDefaultModel();
    };

    const conversationResolved = await resolveAgentModel("conversation");
    if (conversationResolved.isErr()) return err(conversationResolved.error);
    const sandboxResolved = await resolveAgentModel("sandbox");
    if (sandboxResolved.isErr()) return err(sandboxResolved.error);
    const conversationModel = conversationResolved.value;
    const sandboxModel = sandboxResolved.value;

    const pgResult = await seams.ensurePostgres();
    if (pgResult.isErr()) return err({ type: "postgres_unavailable", cause: pgResult.error });
    const conn = pgResult.value;

    // The local CLI is a POLL-mode embedder: the host polls the sandbox for
    // results, the sandbox initiates nothing, and there is no callback listener to
    // bind (which is what closes #27/#41 locally). Callback mode — an ingress plus
    // an advertised CORTEX_BASE_URL — exists for a managed embedder, not here.
    let ingress: ExecIngress;
    if (SANDBOX_TRANSPORT === "callback") {
        const ingressResult = seams.startIngress();
        if (ingressResult.isErr()) return err({ type: "ingress_failed", cause: ingressResult.error });
        ingress = ingressResult.value;
    } else {
        ingress = noopExecIngress();
    }

    // Serialize the DBOS-owning section: every process launches DBOS as executor
    // "local", so a second concurrent boot's launch-time recovery would adopt and
    // re-run this one's in-flight workflows. A stable executor id is required for
    // crash recovery (a killed run resumes on the next boot), so we exclude
    // concurrent runtimes with an advisory lock rather than randomizing the id; a
    // hard-killed prior holder's lock is reclaimed by pid, so it never wedges boot.
    const lock = acquireInstanceLock(RUNTIME_LOCK_KEY);
    if (!lock.acquired) {
        ingress.stop();
        return err({ type: "runtime_already_active", holderPid: lock.holderPid });
    }

    // Registration + launch throw on failure (DBOS SDK contract) — bridge to
    // Result and release the ingress + runtime lock so a failed boot leaves
    // nothing bound.
    let pool: Pool | null = null;
    try {
        pool = createPool({
            host: conn.host,
            port: String(conn.port),
            database: conn.database,
            user: conn.user,
            password: conn.password,
            sslMode: "disable",
        });

        const resolveBilling = createNoopBillingResolver();

        // The workspace-root seam realization (workspace-root-resolution spec):
        // analysis id → `<anchorPath>/.inflexa/analyses/<slug>`, derived from DB
        // state on every call so a DBOS-recovered workflow in a fresh process (or
        // after a reconciled anchor move) resolves the current location. Injective
        // via `UNIQUE (anchor_id, slug)`. THROWS on failure — the seam contract
        // requires resolution failures to cross DBOS step boundaries as throws (a
        // returned err would be durably cached as step success); this is a
        // sanctioned boundary throw, the same bridge role as the harness's own
        // `unwrapOrThrow`.
        const resolveWorkspaceRoot = (analysisId: string): string =>
            workspaceRootForAnalysisId(analysisId).match(
                (root) => root,
                (e) => {
                    throw new Error(e.type === "workspace_unavailable" ? e.message : `workspace root for ${analysisId}: ${e.type}`);
                },
            );

        // Shared backends built ONCE so the profile workflow, the sandbox-step
        // child, the execute-analysis parent, the ephemeral runner, and the
        // conversation agent all close over the SAME instances — EXCEPT the chat
        // provider, which splits per user-facing agent below. The embedding provider is
        // NOT built here — it was resolved up-front (`embedding`, via the
        // resolveEmbedding seam) and is threaded through unchanged, so every path shares
        // the one resolved instance. `cfg.skillsDir` and `cfg.templatesDir` are non-null
        // here — the pre-flight above returned if either was null.
        //
        // One provider instance per DISTINCT resolved agent model over the SHARED
        // connection: the wire model is baked into each `ChatProvider`
        // at construction (`ChatRequest` carries no model), so two agents on different
        // models mean two instances — but two agents on the SAME model share ONE instance
        // referentially, which is the common no-`agents` config (one provider). One
        // construction path for both connection modes: the
        // resolved connection + a bound model becomes an `AiSdkProviderConfig`. cliproxy
        // resolves to the Anthropic kind at the owned proxy URL with the proxy client key
        // — deliberately identical to what the harness's `createAnthropicProvider`
        // convenience wrapper emits (same kind/baseURL/apiKey/model and `capabilities: {
        // toolCalling: true }`), so the proxy path is indistinguishable from a bare
        // Anthropic connection. direct resolves to the configured protocol kind at the
        // configured endpoint with the env secret.
        const providerConfigFor = (agentModel: string): AiSdkProviderConfig =>
            connection.mode === "cliproxy"
                ? { kind: "anthropic", baseURL: env.cliproxyApiUrl, apiKey: providerApiKey, model: agentModel, capabilities: { toolCalling: true } }
                : connection.protocol === "anthropic"
                  ? { kind: "anthropic", baseURL: connection.baseURL, apiKey: providerApiKey, model: agentModel, capabilities: { toolCalling: true } }
                  : {
                        kind: "openai-compatible",
                        name: connection.provider,
                        baseURL: connection.baseURL,
                        apiKey: providerApiKey,
                        model: agentModel,
                        capabilities: { toolCalling: true },
                    };
        const buildProvider = (agentModel: string): ChatProvider => createConfiguredAiSdkProvider({ resolveBilling, config: providerConfigFor(agentModel) });
        // Coincident agent models share the one INNER instance; only a genuinely distinct sandbox model
        // constructs a second inner over the same shared connection (one connection, one instance per
        // DISTINCT model).
        const conversationInner = buildProvider(conversationModel);
        const sandboxInner = sandboxModel === conversationModel ? conversationInner : buildProvider(sandboxModel);
        // Each agent gets its OWN swappable handle even when the inners coincide, so a later switch of one
        // agent re-points only that agent. The handle is the stable reference every
        // consumer captures — the run-engine deps bundles, the conversation agent's sub-agents, and the
        // streaming chat wrapper — so swapping its inner at the idle transition reaches them all at once.
        const conversationProvider = createSwappableProvider(conversationInner);
        const sandboxProvider = createSwappableProvider(sandboxInner);
        const conversationBackend: AgentBackend = { provider: conversationProvider, model: conversationModel };
        const sandboxBackend: AgentBackend = { provider: sandboxProvider, model: sandboxModel };
        const sandboxClient = createSandboxClient({
            pool,
            // TODO(extend): sandbox steps always target docker — the harness sandbox backend is
            // docker|k8s only, so even a pinned-podman machine still needs Docker here; podman
            // sandbox support is a harness capability to add first, not a CLI flag.
            env: { backend: "docker", namespace: "" },
            transport: SANDBOX_TRANSPORT,
            // Empty in poll mode (the no-op ingress advertises no URL); the sandbox
            // never dials out, so the harness ignores it.
            cortexBaseUrl: ingress.cortexBaseUrl,
            // The sandbox image bakes the library store at /mnt/libs/current, so
            // the local path creates no `/mnt/libs` bind mount and forces no
            // container platform (the multi-arch image resolves the host arch at
            // pull time). Managed still mounts the tarballs via its PVC — that
            // lives in infra/harness config, not here.
            image: cfg.sandboxImage,
            ...existingRefStoreConfig(env.refsDir),
            resourceLimits: cfg.resourcePolicy.perStep,
            resolveWorkspaceRoot,
        });
        const workspaceFs = createWorkspaceFilesystem({ resolveWorkspaceRoot });
        // One authorizer instance, shared by the parent workflow's terminal revoke,
        // the run-trigger flow's async-edge authorize, AND the conversation agent's
        // execute_plan / run_ephemeral tools (the local realization is stateless, so
        // sharing is purely to avoid duplication).
        const runAuthorizer = createLocalRunAuthorizer();
        // One launcher instance, shared by the conversation agent's execute_plan
        // tool (wired through the conversation bundle) and the file-replay run
        // trigger (`runTriggerDeps`) — same reasoning as the shared authorizer: a
        // single seam realization drives every durable-run launch on this analysis.
        const runLauncher = createDbosRunLauncher();

        // ONE holder of the sandbox agent's provenance emitters, stamped WITH the boot `{provider}/{model}`
        // name and injected as STABLE delegating handles into the run-engine deps bundles below. The
        // registered workflows hold these identities for the runtime's life; a live sandbox-model switch
        // re-points only the cli-owned inner behind them via `emitters.swap`, so
        // no harness-held object is mutated and the swap lands regardless of the workflows' read discipline.
        const emitters = createSwappableSandboxEmitters(`${connection.provider}/${sandboxModel}`);

        const composition: RunEngineComposition = {
            pool,
            embedding,
            sandboxClient,
            workspaceFs,
            resolveWorkspaceRoot,
            // Both user-facing agents carried on the one composition. The run-engine
            // bundles draw `sandbox`; `conversation` rides so boot has a single carrier for the
            // conversation assembly and the handle. Each carries its resolved model bare (the API
            // model param); the prov-bridge emitters compose the `{provider}/{model}` provenance name
            // from the sandbox agent's model and the CONFIGURED provider slug below.
            conversation: conversationBackend,
            sandbox: sandboxBackend,
            // The connection's configured provider slug — the attested fact provenance records,
            // shared across agents, never derived from a model id.
            modelProvider: connection.provider,
            // The stable delegating sandbox emitters the run-engine bundles inject.
            sandboxEmitters: emitters,
            skillsDir: cfg.skillsDir,
            bioKeys: cfg.bioKeys,
        };

        // Registration cohort — ONE pre-launch call. `assembleCoreRuntime`
        // registers all five durable workflows and builds the conversation agent over
        // the registered callables. Child-before-parent ordering is the harness's
        // invariant now: `buildExecuteAnalysis` receives the registered sandbox-step
        // callable, an ordering its builder API makes a type error to violate — the
        // cli no longer hand-maintains a mirror of it. `executeTargetAssessment` is
        // registered DELIBERATELY UNTRIGGERABLE: no cli surface launches it, so it is
        // never recovered — harmless wiring the one-cohort discipline requires, not
        // dead code. Everything lands before `launch`, the invariant that
        // matters: recovery resolves in-flight workflows by registered name, so
        // nothing the cli can trigger may register after.
        const workflows: CoreWorkflowDeps = {
            sandboxStep: buildSandboxStepDeps(composition),
            buildExecuteAnalysis: (sandboxStep) => buildExecuteAnalysisDeps(composition, sandboxStep, runAuthorizer),
            executeTargetAssessment: buildExecuteTargetAssessmentDeps(composition, runAuthorizer),
            // The data-profile deps stay an inline bundle: every field is a shared
            // backend plus the shared authorizer, so there is no reusable builder to
            // extract (unlike the two run-engine bundles). Data profiling is a SANDBOX-agent
            // activity, so it takes the sandbox provider + model.
            dataProfile: {
                provider: sandboxProvider,
                pool,
                sandboxClient,
                workspaceFs,
                resolveWorkspaceRoot,
                model: sandboxModel,
                runAuthorizer,
                bioKeys: cfg.bioKeys,
                embedding,
                skillsDir: cfg.skillsDir,
            },
            ephemeral: buildEphemeralDeps(composition),
        };
        // The conversation agent's dep surface minus the three fields
        // `assembleCoreRuntime` injects itself (both workflow callables + the resource
        // policy). Every non-chat backend is the shared instance; the chat provider +
        // model are the CONVERSATION agent's. `templatesDir` is
        // non-null past the pre-flight gate; `chrome: {}` is the honest local default —
        // with the unavailable preview publisher, report preview short-circuits before
        // any Chrome connection.
        const conversation: ConversationAssemblyDeps = {
            provider: conversationProvider,
            pool,
            embedding,
            workspaceFs,
            model: conversationModel,
            resolveWorkspaceRoot,
            runAuthorizer,
            runLauncher,
            createPreviewPublisher: async () => new UnavailablePreviewPublisher(),
            bioKeys: cfg.bioKeys,
            templatesDir: cfg.templatesDir,
            // The in-process report-builder gets read-only `report-html` skill tools.
            skillsDir: cfg.skillsDir,
            chrome: {},
        };
        // Re-point the sandbox agent's provenance emitters when its model switches live.
        // The run-engine bundles injected the holder's STABLE `artifactRegistry` / `emitProvenance`
        // handles, so the harness holds ONE identity for each for the runtime's life; a swap replaces only
        // the cli-owned inner those handles delegate to, rebuilt WITH the new `{provider}/{model}` name
        // stamped at construction. Correctness is therefore independent of when or how often
        // the registered workflows read their deps fields — a field snapshotted at registration still sees
        // the swap — so no harness read-discipline assumption is load-bearing here. In-flight work, excluded
        // by the idle gate, keeps the emitters it started with; the conversation agent needs no equivalent
        // because chat turns write the Solid store, never the provenance bus.
        const swapSandboxEmitters = (name: `${string}/${string}`): void => emitters.swap(name);

        // Host-specific pre-launch work, run by `bootHarness` AFTER it registers
        // the workflow cohort and BEFORE `DBOS.launch()`:
        //   1. Cancel this executor's stale PENDING `ephemeral:*` rows. The assemble
        //      step makes a prior crash's row re-dispatchable by launch-time
        //      recovery; the only race-free cancel point is a direct system-DB
        //      UPDATE that lands before launch — which `beforeLaunch` guarantees.
        //   2. Install the live-switch controller. Its run-bus subscription must be
        //      attached when launch-time recovery re-emits `run_started` for
        //      reclaimed runs, or the gauge would miss them and let a switch land
        //      mid-recovery.
        //   3. Register the sandbox-hygiene crons (reaper tears down orphaned
        //      containers, watchdog converts a dead sandbox into a step failure,
        //      sweep clears stale notification rows) — the embedder's duty, acting
        //      only on rows/containers the harness created.
        // Every pool read uses `composition.pool` (typed `Pool`), not the
        // `Pool | null` local whose narrowing this deferred closure does not preserve.
        const beforeLaunch = async (): Promise<void> => {
            await seams.sweepEphemeral({ pool: composition.pool, logger, executorId: "local" });
            installAgentSwitch({
                swappable: { conversation: conversationProvider, sandbox: sandboxProvider },
                rebuildProvider: buildProvider,
                swapSandboxEmitters,
                modelProvider: connection.provider,
                initialModels: { conversation: conversationModel, sandbox: sandboxModel },
            });
            seams.registerReaper({ pool: composition.pool, sandboxClient, logger });
            seams.registerWatchdog({ queryActiveSandboxes: () => queryActiveSandboxes(composition.pool), sandboxClient, logger });
            seams.registerNotificationSweep({ pool: composition.pool, logger });
        };

        // Hand the harness the resolved inputs and let it own the ordered boot
        // tail — validate skills → init state → assert the connection budget →
        // assemble the durable cohort → `beforeLaunch` → launch — plus the
        // graceful-shutdown handle wired to close this pool.
        const booted = await seams.boot({
            core: { conversation, workflows, resourcePolicy: cfg.resourcePolicy },
            pool: composition.pool,
            skillsDir: cfg.skillsDir,
            dbos: {
                dbHost: conn.host,
                dbPort: String(conn.port),
                dbName: conn.database,
                dbUser: conn.user,
                dbPassword: conn.password,
                dbSslMode: "disable",
                appName: "inflexa",
                adminPort: String(cfg.adminPort),
                executorId: "local",
                // The SDK's info-level launch banner would interleave with the
                // profile command's clack output; warnings still surface.
                logLevel: "warn",
            },
            // Local single-pod CLI: no `DB_POOL_MAX` override, so the guard reads
            // the default app-pool size.
            connectionBudget: {},
            logger,
            beforeLaunch,
            // The CLI owns its OWN OpenTelemetry (`lib/otel.ts`); the harness must
            // NOT double-init — its `initOtel` prints a console banner that would
            // corrupt the TUI. Telemetry init/flush stay CLI-side, so they are
            // no-ops here (the boot handle's default).
            initTelemetry: () => {},
            // The harness's HTTP-drain slot. In poll mode the ingress is a no-op,
            // but wiring it keeps the drain ordered ahead of DBOS shutdown.
            closeHttpServer: async () => ingress.stop(),
            // The CLI owns process exit (`lib/shutdown.ts` flushes logs/otel then
            // exits), so the harness shutdown must not call `process.exit`.
            exit: () => {},
        });
        const core = booted.runtime;

        const runtime: HarnessRuntime = {
            conversation: conversationBackend,
            sandbox: sandboxBackend,
            pool,
            triggerDeps: { pool, runAuthorizer, workflow: core.workflows.dataProfile },
            runTriggerDeps: { pool, executeAnalysis: core.workflows.executeAnalysis, runLauncher, runAuthorizer, budget: cfg.resourcePolicy.budget },
            conversationAgent: core.conversationAgent,
            // The connection's identity the boot resolved — surfaced by the status UI, immutable across
            // live agent-model swaps (the connection is shared by both agents, so a swap changes only a
            // model), so `provider`/`mode` are read straight off the connection.
            connection: { provider: connection.provider, mode: connection.mode },
            ingress,
        };
        active = runtime;

        onShutdown(async () => {
            // The harness's graceful-shutdown handle drives the durability-ordered
            // teardown: mark draining, drain the ingress (via `closeHttpServer`),
            // shut DBOS down, then close the pool. `exit` is a no-op — the CLI owns
            // process exit.
            await booted.shutdown("cli-shutdown");
            // CLI-owned teardown the harness has no slot for: detach the live-switch
            // controller (its bus subscription + gauge) and release the machine-wide
            // runtime lock so the next boot can acquire it.
            clearAgentSwitch();
            releaseInstanceLock(RUNTIME_LOCK_KEY);
            active = null;
        });

        return ok(runtime);
    } catch (cause) {
        ingress.stop();
        if (pool) {
            await pool.end().catch(() => {
                // Already failing boot; pool-drain noise would mask the real cause.
            });
        }
        // `installAgentSwitch` may have run before the throw (it precedes `launch`); detach it so a failed
        // boot leaves no dangling bus subscription behind.
        clearAgentSwitch();
        releaseInstanceLock(RUNTIME_LOCK_KEY);
        return err({ type: "runtime_boot_failed", cause });
    }
}
