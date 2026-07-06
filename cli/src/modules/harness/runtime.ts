import { existsSync } from "node:fs";
import type pino from "pino";
import { ok, err, type Result } from "neverthrow";
import {
    createAnthropicProvider,
    createDbosRunLauncher,
    createLocalRunAuthorizer,
    createNoopBillingResolver,
    createPool,
    createSandboxClient,
    createWorkspaceFilesystem,
    initCortexState,
    launchDbos,
    makeLocalAuth,
    queryActiveSandboxes,
    registerDataProfileWorkflow,
    registerExecuteAnalysis,
    registerNotificationSweep,
    registerSandboxReaper,
    registerSandboxStep,
    registerWatchdog,
    shutdownDbos,
    type AgentSession,
    type DataProfileDeps,
    type DataProfileTriggerDeps,
    type DataProfileWorkflowInput,
    type DbosConfig,
    type EmbeddingProvider,
    type ExecuteAnalysisDeps,
    type ExecuteAnalysisInput,
    type ExecuteAnalysisResult,
    type MachineBudget,
    type Pool,
    type RegisterNotificationSweepDeps,
    type RegisterReaperDeps,
    type RunAuthorizer,
    type RunLauncher,
    type SandboxStepDeps,
    type SandboxStepInput,
    type SandboxStepResult,
    type WatchdogDeps,
} from "@inflexa-ai/harness";

import { readConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { acquireInstanceLock, releaseInstanceLock } from "../../lib/lock.ts";
import { getLogger } from "../../lib/log.ts";
import { onShutdown } from "../../lib/shutdown.ts";
import { resolveEmbedder, type EmbeddingResolveError } from "../embedding/resolve.ts";
import { ensurePostgresReady } from "../infra/postgres.ts";
import type { PostgresConnection, PostgresError } from "../infra/postgres_types.ts";
import { readApiKey, resolveModelId, type ChatSetupError } from "../intelligence/chat.ts";
import { resolveHarnessConfig, type ResolvedHarnessConfig } from "./config.ts";
import { startExecIngress, type ExecIngress, type IngressError } from "./ingress.ts";
import { buildExecuteAnalysisDeps, buildSandboxStepDeps, type RunEngineComposition } from "./run_deps.ts";

// The embedded-harness composition root. Boots lazily on the first profile
// trigger (never from a passive flow — no-litter policy) and holds a process
// singleton: workflow deps are closed over at registration and DBOS forbids
// re-registering a name, so there is exactly one runtime per process, one
// `sessionsBasePath`, one registration cohort.
//
// Registration happens BEFORE `launchDbos`: `DBOS.launch()` runs recovery
// synchronously and resolves in-flight workflows by their registered name, so a
// workflow not registered at launch cannot be reclaimed. This matches
// `assembleCoreRuntime`, the declared source of truth for wiring order.

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
    /** Chat model id in use (config override or the proxy's default). */
    readonly model: string;
    /** App pool over the provisioned Postgres — shared with the harness ledger queries. */
    readonly pool: Pool;
    /** Ready-to-use deps for `triggerDataProfile`. */
    readonly triggerDeps: DataProfileTriggerDeps;
    /** Ready-to-use deps for the analysis-run trigger flow. */
    readonly runTriggerDeps: RunTriggerDeps;
    readonly ingress: ExecIngress;
};

/** Why the runtime could not boot — each variant maps to one actionable user message. */
export type HarnessBootError =
    | { type: "harness_config_invalid"; issues: string }
    | { type: "embedding_unresolved"; cause: EmbeddingResolveError }
    | { type: "embedding_probe_failed"; detail: string }
    | { type: "embedding_dimension_mismatch"; expected: number; actual: number }
    | { type: "skills_dir_missing"; path: string | null }
    | { type: "proxy_key_missing"; cause: ChatSetupError }
    | { type: "model_unresolved"; cause: ChatSetupError }
    | { type: "model_not_claude"; model: string }
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
    readonly resolveModel: (apiKey: string) => Promise<Result<string, ChatSetupError>>;
    readonly resolveEmbedding: () => Result<EmbeddingProvider, EmbeddingResolveError>;
    readonly register: (deps: DataProfileDeps) => (input: DataProfileWorkflowInput) => Promise<void>;
    /** Register the sandbox-step CHILD workflow — must run before {@link BootSeams.registerExecuteAnalysis}. */
    readonly registerSandboxStep: (deps: SandboxStepDeps) => (input: SandboxStepInput) => Promise<SandboxStepResult>;
    /** Register the execute-analysis PARENT workflow — its deps close over the child callable. */
    readonly registerExecuteAnalysis: (deps: ExecuteAnalysisDeps) => (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult>;
    /** Register the orphaned-container reaper scheduled workflow (design D5). */
    readonly registerReaper: (deps: RegisterReaperDeps) => void;
    /** Register the dead-sandbox liveness watchdog scheduled workflow (design D5). */
    readonly registerWatchdog: (deps: WatchdogDeps) => void;
    /** Register the stale-notification sweep scheduled workflow (design D5). */
    readonly registerNotificationSweep: (deps: RegisterNotificationSweepDeps) => void;
    readonly initState: (pool: Pool) => Promise<void>;
    readonly launch: (args: { config: DbosConfig; logger: pino.Logger }) => Promise<void>;
    readonly probeEmbedding: typeof probeEmbeddingProvider;
};

const realSeams: BootSeams = {
    ensurePostgres: ensurePostgresReady,
    startIngress: () => startExecIngress(),
    readKey: readApiKey,
    resolveModel: resolveModelId,
    resolveEmbedding: () => resolveEmbedder(readConfig()),
    register: registerDataProfileWorkflow,
    registerSandboxStep,
    registerExecuteAnalysis,
    registerReaper: registerSandboxReaper,
    registerWatchdog,
    registerNotificationSweep,
    initState: initCortexState,
    launch: launchDbos,
    probeEmbedding: probeEmbeddingProvider,
};

/**
 * Advisory-lock key for the embedded runtime (see `lib/lock.ts`). A fixed
 * sentinel — not an analysis id — because the lock guards the single per-machine
 * DBOS engine (executor "local"), not any one analysis. Never collides with an
 * analysis lock: analysis ids are UUIDv7.
 */
const RUNTIME_LOCK_KEY = "harness-runtime";

let active: HarnessRuntime | null = null;

/** The booted runtime, if any — passive callers (status views) may read, never boot. */
export function activeHarnessRuntime(): HarnessRuntime | null {
    return active;
}

/** Test hook: drop the singleton without shutting anything down. Test-only. */
export function __resetHarnessRuntimeForTest(): void {
    active = null;
}

/**
 * Boot (or return) the embedded harness runtime. Sequence: prerequisites →
 * Postgres readiness → callback ingress → schema init → workflow registration
 * → DBOS launch. Idempotent per process; the shutdown hook is registered once,
 * on success.
 */
export async function bootHarnessRuntime(
    options: { seams?: Partial<BootSeams>; config?: ResolvedHarnessConfig } = {},
): Promise<Result<HarnessRuntime, HarnessBootError>> {
    if (active) return ok(active);
    const seams: BootSeams = { ...realSeams, ...options.seams };
    const cfg = options.config ?? resolveHarnessConfig();
    const logger = getLogger("harness");

    // A `harness` config block that was present but failed validation: report the
    // offending fields, not a misleading downstream error. Checked first so a bad
    // `adminPort` type never surfaces as "embedding not configured".
    if (cfg.configError) return err({ type: "harness_config_invalid", issues: cfg.configError.issues });

    // Prerequisites that no amount of booting can heal — checked before any
    // side effect so a misconfigured run costs nothing. The embedder comes from
    // the top-level `embedding` config key (the single embedding surface,
    // written by `inflexa setup --embeddings`), never from the chat proxy: the
    // proxy fronts OAuth chat providers and serves no embeddings route.
    if (cfg.skillsDir === null || !existsSync(cfg.skillsDir)) {
        return err({ type: "skills_dir_missing", path: cfg.skillsDir });
    }
    const embedderResult = seams.resolveEmbedding();
    if (embedderResult.isErr()) return err({ type: "embedding_unresolved", cause: embedderResult.error });
    const embedding = embedderResult.value;

    const keyResult = await seams.readKey();
    if (keyResult.isErr()) return err({ type: "proxy_key_missing", cause: keyResult.error });
    const apiKey = keyResult.value;

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

    const autoResolvedModel = cfg.model === null;
    let model = cfg.model;
    if (model === null) {
        const modelResult = await seams.resolveModel(apiKey);
        if (modelResult.isErr()) return err({ type: "model_unresolved", cause: modelResult.error });
        model = modelResult.value;
    }
    // The data-profile agent reaches the proxy over the Anthropic Messages
    // protocol (`createAnthropicProvider` below). When no Claude model is
    // authenticated, the auto-resolver falls through to whatever family the proxy
    // advertises (gpt/gemini/qwen); wiring a non-Claude id into the Anthropic
    // route fails only at the first model round, after the sandbox has spun up.
    // Reject it at boot. An explicitly-configured `harness.model` is trusted (it
    // may be a proxy alias that resolves to Claude), so this guards the auto path.
    if (autoResolvedModel && !model.toLowerCase().includes("claude")) {
        return err({ type: "model_not_claude", model });
    }

    const pgResult = await seams.ensurePostgres();
    if (pgResult.isErr()) return err({ type: "postgres_unavailable", cause: pgResult.error });
    const conn = pgResult.value;

    const ingressResult = seams.startIngress();
    if (ingressResult.isErr()) return err({ type: "ingress_failed", cause: ingressResult.error });
    const ingress = ingressResult.value;

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

        // Harness app tables (cortex_*) must exist before launch: DBOS recovery
        // may resume a profile workflow that queries them on its first step.
        await seams.initState(pool);

        const resolveBilling = createNoopBillingResolver();

        // Shared backends built ONCE so the profile workflow, the sandbox-step
        // child, and the execute-analysis parent all close over the SAME
        // instances. `provider` is a `ChatProvider` (it satisfies the
        // sandbox-step's `AgentChat` seam too). The embedding provider is NOT
        // built here — it was resolved up-front (`embedding`, via the
        // resolveEmbedding seam) and is threaded through unchanged, so the profile
        // path and the run engine share the one resolved instance. `cfg.skillsDir`
        // is non-null here — the pre-flight above returned if it was null.
        const provider = createAnthropicProvider({ baseURL: env.cliproxyApiUrl, token: apiKey, model, resolveBilling });
        const sandboxClient = createSandboxClient({
            pool,
            env: { backend: "docker", namespace: "" },
            cortexBaseUrl: ingress.cortexBaseUrl,
            image: cfg.sandboxImage,
            resourceLimits: cfg.resourcePolicy.perStep,
            sessionsBasePath: env.sessionsDir,
        });
        const workspaceFs = createWorkspaceFilesystem({ sessionsBasePath: env.sessionsDir });
        // One authorizer instance, shared by the parent workflow's terminal
        // revoke and the run-trigger flow's async-edge authorize (the local
        // realization is stateless, so sharing is purely to avoid duplication).
        const runAuthorizer = createLocalRunAuthorizer();

        const composition: RunEngineComposition = {
            pool,
            provider,
            embedding,
            sandboxClient,
            workspaceFs,
            sessionsBasePath: env.sessionsDir,
            model,
            skillsDir: cfg.skillsDir,
            bioKeys: cfg.bioKeys,
        };

        // Registration cohort — ONE pre-launch batch (design D1/D5). Child before
        // parent: the parent's dispatch closes over the registered child callable,
        // so `registerSandboxStep` must precede `registerExecuteAnalysis` (mirrors
        // `assemble.ts:75-76`). The three sandbox-hygiene scheduled workflows join
        // the same batch. All of it lands before `launch`, which is the invariant
        // that matters: DBOS recovery at launch resolves in-flight workflows by
        // their registered name, so nothing the cli can trigger may register after.
        //
        // TODO(robustness): live kill/resume is verified for the analysis-run path
        // (executeAnalysis parent/child) but NOT separately for the data-profile
        // workflow registered just below — both share this single recovery path
        // (one runtime, executor "local", reclaimed at launch by registered name),
        // so the run-path proof exercises the identical mechanism, but the
        // data-profile path has not been exercised live. Tracked in issue #28.
        const sandboxStepCallable = seams.registerSandboxStep(buildSandboxStepDeps(composition));
        const executeAnalysis = seams.registerExecuteAnalysis(buildExecuteAnalysisDeps(composition, sandboxStepCallable, runAuthorizer));

        const workflow = seams.register({
            provider,
            pool,
            sandboxClient,
            workspaceFs,
            sessionsBasePath: env.sessionsDir,
            model,
            runAuthorizer,
            bioKeys: cfg.bioKeys,
            embedding,
            skillsDir: cfg.skillsDir,
        });

        // Sandbox-hygiene crons: reaper tears down orphaned containers a killed
        // host left behind; the watchdog converts a dead sandbox into a prompt
        // step failure instead of a deadline-long hang; the sweep clears stale
        // notification rows. They act only on rows/containers the harness created.
        seams.registerReaper({ pool, sandboxClient, logger });
        // `composition.pool` (typed `Pool`) rather than the `Pool | null`-typed
        // `pool` local, whose narrowing a deferred closure does not preserve.
        seams.registerWatchdog({ queryActiveSandboxes: () => queryActiveSandboxes(composition.pool), sandboxClient, logger });
        seams.registerNotificationSweep({ pool, logger });

        await seams.launch({
            config: {
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
            logger,
        });

        const runtime: HarnessRuntime = {
            model,
            pool,
            triggerDeps: { pool, runAuthorizer, workflow },
            runTriggerDeps: { pool, executeAnalysis, runLauncher: createDbosRunLauncher(), runAuthorizer, budget: cfg.resourcePolicy.budget },
            ingress,
        };
        active = runtime;

        onShutdown(async () => {
            // DBOS first (it never throws and needs the DB), then the listener,
            // then the pool the harness queries with, then the runtime lock so the
            // next boot can acquire it.
            await shutdownDbos({ logger });
            ingress.stop();
            await runtime.pool.end().catch(() => {
                // The process is exiting; a pool that won't drain must not block it.
            });
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
        releaseInstanceLock(RUNTIME_LOCK_KEY);
        return err({ type: "runtime_boot_failed", cause });
    }
}
