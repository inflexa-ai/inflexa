import { existsSync } from "node:fs";
import type pino from "pino";
import { ok, err, type Result } from "neverthrow";
import {
    createAnthropicProvider,
    createLocalRunAuthorizer,
    createNoopBillingResolver,
    createPool,
    createSandboxClient,
    createWorkspaceFilesystem,
    initCortexState,
    launchDbos,
    registerDataProfileWorkflow,
    shutdownDbos,
    SEARCH_INDEX_DIMENSION,
    type DataProfileDeps,
    type DataProfileTriggerDeps,
    type DataProfileWorkflowInput,
    type DbosConfig,
    type Pool,
} from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import { acquireInstanceLock, releaseInstanceLock } from "../../lib/lock.ts";
import { getLogger } from "../../lib/log.ts";
import { onShutdown } from "../../lib/shutdown.ts";
import { ensurePostgresReady } from "../infra/postgres.ts";
import type { PostgresConnection, PostgresError } from "../infra/postgres_types.ts";
import { readApiKey, resolveModelId, type ChatSetupError } from "../intelligence/chat.ts";
import { resolveHarnessConfig, type HarnessEmbeddingConfig, type ResolvedHarnessConfig } from "./config.ts";
import { startExecIngress, type ExecIngress, type IngressError } from "./ingress.ts";

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

/** The booted runtime — everything the launch command needs to trigger and observe runs. */
export type HarnessRuntime = {
    /** Chat model id in use (config override or the proxy's default). */
    readonly model: string;
    /** App pool over the provisioned Postgres — shared with the harness ledger queries. */
    readonly pool: Pool;
    /** Ready-to-use deps for `triggerDataProfile`. */
    readonly triggerDeps: DataProfileTriggerDeps;
    readonly ingress: ExecIngress;
};

/** Why the runtime could not boot — each variant maps to one actionable user message. */
export type HarnessBootError =
    | { type: "harness_config_invalid"; issues: string }
    | { type: "embedding_unconfigured" }
    | { type: "embedding_unreachable"; baseURL: string; detail: string }
    | { type: "embedding_dimension_mismatch"; baseURL: string; expected: number; actual: number }
    | { type: "skills_dir_missing"; path: string | null }
    | { type: "proxy_key_missing"; cause: ChatSetupError }
    | { type: "model_unresolved"; cause: ChatSetupError }
    | { type: "model_not_claude"; model: string }
    | { type: "postgres_unavailable"; cause: PostgresError }
    | { type: "ingress_failed"; cause: IngressError }
    | { type: "runtime_already_active"; holderPid: number }
    | { type: "runtime_boot_failed"; cause: unknown };

/** Why the embedding probe failed — reachability vs. a servable-but-wrong-width model. */
export type EmbeddingProbeError =
    { kind: "unreachable"; baseURL: string; detail: string } | { kind: "dimension_mismatch"; baseURL: string; expected: number; actual: number };

/**
 * Boot-time probe for the embedding endpoint. Embeddings are consumed LATE in
 * the profile workflow — after the sandbox agent already spent its LLM budget —
 * and both an unreachable endpoint AND a wrong-width model are fatal there: the
 * per-analysis pgvector index is pinned to {@link SEARCH_INDEX_DIMENSION}, so a
 * model of any other width is rejected at the vector upsert. One cheap real
 * embedding up front converts both expensive late failures into free early ones.
 * A real POST rather than an OPTIONS/HEAD sniff: OpenAI-compatible servers
 * disagree on everything except the actual call, and only the actual response
 * carries the vector length we need to check.
 */
async function probeEmbeddingEndpoint(embedding: HarnessEmbeddingConfig): Promise<Result<void, EmbeddingProbeError>> {
    try {
        const res = await fetch(`${embedding.baseURL.replace(/\/$/, "")}/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${embedding.token}` },
            body: JSON.stringify({ model: embedding.model, input: ["ping"], encoding_format: "float" }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            return err({ kind: "unreachable", baseURL: embedding.baseURL, detail: `HTTP ${res.status}` });
        }
        // Verify the model's dimension against the pinned index width. Parse
        // defensively: on any nonstandard-but-200 shape we can't read a length
        // from, accept reachability rather than false-block a working endpoint —
        // the dimension check is a best-effort early warning, not a gate.
        const body: unknown = await res.json(); // external response; shape narrowed below before use
        const actual = extractEmbeddingLength(body);
        if (actual !== null && actual !== SEARCH_INDEX_DIMENSION) {
            return err({ kind: "dimension_mismatch", baseURL: embedding.baseURL, expected: SEARCH_INDEX_DIMENSION, actual });
        }
        return ok(undefined);
    } catch (cause) {
        return err({ kind: "unreachable", baseURL: embedding.baseURL, detail: cause instanceof Error ? cause.message : String(cause) });
    }
}

/** Pull `data[0].embedding.length` from an OpenAI-compatible embeddings response, or null if the shape isn't the expected `{ data: [{ embedding: number[] }] }`. */
function extractEmbeddingLength(body: unknown): number | null {
    if (typeof body !== "object" || body === null || !("data" in body)) return null;
    const data = (body as { data: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    if (typeof first !== "object" || first === null || !("embedding" in first)) return null;
    const vec = (first as { embedding: unknown }).embedding;
    return Array.isArray(vec) ? vec.length : null;
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
    readonly register: (deps: DataProfileDeps) => (input: DataProfileWorkflowInput) => Promise<void>;
    readonly initState: (pool: Pool) => Promise<void>;
    readonly launch: (args: { config: DbosConfig; logger: pino.Logger }) => Promise<void>;
    readonly probeEmbedding: typeof probeEmbeddingEndpoint;
};

const realSeams: BootSeams = {
    ensurePostgres: ensurePostgresReady,
    startIngress: () => startExecIngress(),
    readKey: readApiKey,
    resolveModel: resolveModelId,
    register: registerDataProfileWorkflow,
    initState: initCortexState,
    launch: launchDbos,
    probeEmbedding: probeEmbeddingEndpoint,
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
    // side effect so a misconfigured run costs nothing. Embeddings are their
    // own endpoint (baseURL + API key), deliberately a separate path from the
    // chat proxy: the proxy fronts OAuth chat providers and serves no
    // embeddings route, so there is nothing to default to.
    if (cfg.embedding === null) return err({ type: "embedding_unconfigured" });
    if (cfg.skillsDir === null || !existsSync(cfg.skillsDir)) {
        return err({ type: "skills_dir_missing", path: cfg.skillsDir });
    }

    const keyResult = await seams.readKey();
    if (keyResult.isErr()) return err({ type: "proxy_key_missing", cause: keyResult.error });
    const apiKey = keyResult.value;

    // Probe the configured endpoint before anything expensive: embeddings are
    // consumed LATE in the profile workflow (after the sandbox agent spent its
    // LLM budget) and an unreachable endpoint is fatal there, so reachability
    // is verified while failure is still free.
    const probeResult = await seams.probeEmbedding(cfg.embedding);
    if (probeResult.isErr()) {
        const e = probeResult.error;
        return e.kind === "dimension_mismatch"
            ? err({ type: "embedding_dimension_mismatch", baseURL: e.baseURL, expected: e.expected, actual: e.actual })
            : err({ type: "embedding_unreachable", baseURL: e.baseURL, detail: e.detail });
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
        const workflow = seams.register({
            provider: createAnthropicProvider({ baseURL: env.cliproxyApiUrl, token: apiKey, model, resolveBilling }),
            pool,
            sandboxClient: createSandboxClient({
                pool,
                env: { backend: "docker", namespace: "" },
                cortexBaseUrl: ingress.cortexBaseUrl,
                image: cfg.sandboxImage,
                resourceLimits: cfg.resourceLimits,
                sessionsBasePath: env.sessionsDir,
            }),
            workspaceFs: createWorkspaceFilesystem({ sessionsBasePath: env.sessionsDir }),
            sessionsBasePath: env.sessionsDir,
            model,
            runAuthorizer: createLocalRunAuthorizer(),
            bioKeys: cfg.bioKeys,
            resolveBilling,
            embedding: cfg.embedding,
            skillsDir: cfg.skillsDir,
        });

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
            triggerDeps: { pool, runAuthorizer: createLocalRunAuthorizer(), workflow },
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
