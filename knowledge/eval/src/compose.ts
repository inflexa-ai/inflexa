/**
 * The composition root of the headless evaluation: the eval as a second
 * embedder of the harness, beside the CLI. It builds the `CoreRuntimeDeps`
 * from harness exports only, boots the harness on the campaign database, and
 * gives the runner the booted runtime with the recording providers and the
 * usage recorder of the attempt directory.
 *
 * The composition mirrors the CLI (`cli/src/modules/harness/runtime.ts`,
 * `run_deps.ts`) minus the CLI-only parts: no SQLite ledger, no instance lock,
 * no provenance bridge, no live agent switch, and no farm extension. The farm
 * is the fixed catalog farm of the store, thus a plan package absent from it
 * is an environment fact the runner records, not a link the eval performs.
 *
 * The knowledge client binds in the `with` arm only: to the planner (through
 * the conversation deps and the `knowledge_recommend` host tool) and to every
 * sandbox agent (through `buildStepAgent`). Nothing else differs between the
 * two arms.
 */

import { availableParallelism, totalmem } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";

import {
    bootHarness,
    createConsoleLogger,
    createDbosRunLauncher,
    createEmbeddingProvider,
    createKnowledgeRecommendTool,
    createLocalRunAuthorizer,
    createNoopArtifactRegistry,
    createNoopBillingResolver,
    createNoopRunCharge,
    createPool,
    createSandboxAgents,
    createSandboxClient,
    createWorkspaceFilesystem,
    FARM_LOCK_FILE,
    IMAGE_PACKAGES_FILE,
    runStepDir,
    SANDBOX_AGENT_META,
    type AgentDefinition,
    type BootedHarness,
    type ChatProvider,
    type ConversationAssemblyDeps,
    type CoreWorkflowDeps,
    type EmbeddingProvider,
    type KnowledgeClient,
    type Logger,
    type Pool,
    type ResolveWorkspaceRoot,
    type ResourcePolicy,
    type RunAuthorizer,
    type RunLauncher,
    type SandboxAgentBuildContext,
    type SandboxAgentDeps,
    type SandboxClient,
    type SandboxStepInput,
    type WorkspaceFilesystem,
} from "@inflexa-ai/harness";

import { buildProvider, type ModelConnection } from "./provider.js";
import { recordingProvider, type EvalRole } from "./record-provider.js";
import { readWorkspaceRoot } from "./stage.js";
import { EVAL_ROOT } from "./tasks.js";
import { createEvalUsageRecorder, createJsonlSink, type EvalUsageRecorder, type JsonlSink } from "./usage-sink.js";

/** The skills tree of the repository, the same one the CLI binds in a dev checkout. */
export const DEFAULT_SKILLS_DIR = join(EVAL_ROOT, "..", "..", "skills");

type BioKeys = ConversationAssemblyDeps["bioKeys"];

/** The eval holds no bio key: every external bio tool then reports the absent key per call, as in a bare CLI. */
const NO_BIO_KEYS: BioKeys = { drugbank: "", disgenet: "", epaCcte: "" };

export interface EvalRuntimeOptions {
    readonly campaign: string;
    readonly condition: "with" | "without";
    /** The campaign output directory: holds `workspaces.json`, the durable state behind `resolveWorkspaceRoot`. */
    readonly campaignDir: string;
    /** The attempt directory the sinks write into after boot; `setAttemptDir` moves them per attempt. */
    readonly attemptDir: string;
    /** The campaign database, `postgres://user:pass@host:port/eval_<campaign>`; made when absent. */
    readonly pgUrl: string;
    /** One model connection per role. Two roles with the same connection share one inner provider. */
    readonly connections: Readonly<Record<EvalRole, ModelConnection>>;
    /** The embedding endpoint (OpenAI-shaped), the same seam the CLI binds in its `api-key` mode. */
    readonly embedding: {
        readonly baseUrl: string;
        readonly apiKey: string;
        readonly model?: string;
        readonly dimensions?: number;
    };
    readonly sandbox: {
        /** The sandbox image, already present on the engine; the harness never pulls. */
        readonly image: string;
        /** The package store root; the farm is `<storeDir>/farms/catalog`. */
        readonly storeDir: string;
        /** The reference store, mounted read-only at `/mnt/refs`. */
        readonly refsDir: string;
        /** The Docker-API socket to dial; unset keeps the dockerode default resolution. */
        readonly engineSocketPath?: string;
        /** Set for an engine whose binds keep the host ownership (podman); unset for Docker Desktop. */
        readonly engineBindOwnership?: "host-preserved";
    };
    /** The knowledge client of the `with` arm; ignored in the `without` arm. */
    readonly knowledge?: KnowledgeClient;
    /** The resource policy; unset gives half the machine, the CLI default. */
    readonly resourcePolicy?: ResourcePolicy;
    readonly skillsDir?: string;
    /** The DBOS admin port; unset takes a free port, thus a CLI runtime on the same machine keeps its own. */
    readonly adminPort?: number;
    readonly logger?: Logger;
}

/** The backends the step-agent builder draws from: the eval counterpart of the CLI `RunEngineComposition`. */
export interface EvalComposition {
    readonly pool: Pool;
    readonly logger: Logger;
    readonly embedding: EmbeddingProvider;
    readonly sandboxClient: SandboxClient;
    readonly workspaceFs: WorkspaceFilesystem;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly sandbox: { readonly provider: ChatProvider; readonly model: string };
    readonly skillsDir: string;
    readonly refStorePath: string;
    /** The `inflexa.lock` of the fixed catalog farm. */
    readonly farmLockFile: string;
    readonly imagePackagesFile: string;
    readonly bioKeys: BioKeys;
    /** Bound in the `with` arm only. */
    readonly knowledge?: KnowledgeClient;
}

export interface EvalRuntime extends BootedHarness {
    readonly pool: Pool;
    /** The recording providers, one per role; the planner tool takes `providers.planner`. */
    readonly providers: Readonly<Record<EvalRole, ChatProvider>>;
    readonly models: Readonly<Record<EvalRole, string>>;
    readonly recorder: EvalUsageRecorder;
    readonly sinks: { readonly calls: JsonlSink; readonly usage: JsonlSink };
    readonly composition: EvalComposition;
    readonly runAuthorizer: RunAuthorizer;
    readonly runLauncher: RunLauncher;
    /** The knowledge client the runtime bound, present in the `with` arm only. */
    readonly knowledge?: KnowledgeClient;
    /** Point `calls.jsonl` and `usage.jsonl` at another attempt directory. */
    setAttemptDir(dir: string): void;
}

/** Half the detected machine, the CLI default (`cli/src/modules/harness/config.ts` resolvePolicy). */
export function defaultResourcePolicy(): ResourcePolicy {
    const cpu = Math.max(1, Math.floor(Math.max(1, availableParallelism()) / 2));
    const memoryGb = Math.max(1, Math.floor(Math.max(1, Math.floor(totalmem() / 1024 ** 3)) / 2));
    return { perStep: { maxCpu: cpu, maxMemoryGb: memoryGb, maxGpuCount: 0 }, budget: { cpu, memoryGb } };
}

interface PgParts {
    readonly host: string;
    readonly port: string;
    readonly database: string;
    readonly user: string;
    readonly password: string;
}

function parsePgUrl(pgUrl: string): PgParts {
    const url = new URL(pgUrl);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (database.length === 0) throw new Error(`the Postgres URL names no database: ${pgUrl}`);
    return {
        host: url.hostname,
        port: url.port || "5432",
        database,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
    };
}

/**
 * Make the campaign database when it does not exist. DBOS owns the `dbos`
 * schema of the database it launches in, thus one campaign takes one database
 * and never a schema. The admin connection goes to the `postgres` database of
 * the same server.
 */
export async function ensureCampaignDatabase(pgUrl: string): Promise<void> {
    const parts = parsePgUrl(pgUrl);
    if (!/^[a-z0-9_]+$/.test(parts.database)) throw new Error(`the campaign database name must match [a-z0-9_]+: ${parts.database}`);
    const admin = new URL(pgUrl);
    admin.pathname = "/postgres";
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    try {
        const found = await client.query({ text: "SELECT 1 FROM pg_database WHERE datname = $1", values: [parts.database] });
        if (found.rowCount === 0) await client.query(`CREATE DATABASE "${parts.database}"`);
    } finally {
        await client.end();
    }
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}

/**
 * The step-agent builder, a copy of the CLI `buildStepAgent`
 * (`cli/src/modules/harness/run_deps.ts`): the `SandboxAgentDeps` projection
 * of the composition plus the per-step coordinates, then the catalog agent
 * of the step. The knowledge client rides only when the composition holds
 * one (the `with` arm). `extendAnalysisFarm` stays unbound: the eval mounts
 * the fixed catalog farm, thus no `link_packages` tool exists, and a package
 * the plan names but the farm lacks is an environment fact of the record.
 */
export function buildStepAgent(comp: EvalComposition, ctx: SandboxAgentBuildContext): AgentDefinition {
    const deps: SandboxAgentDeps = {
        logger: comp.logger,
        provider: comp.sandbox.provider,
        pool: comp.pool,
        sandboxClient: comp.sandboxClient,
        workspaceFs: comp.workspaceFs,
        embedding: comp.embedding,
        lineageCollector: ctx.lineageCollector,
        model: comp.sandbox.model,
        skillsDir: comp.skillsDir,
        refStorePath: comp.refStorePath,
        farmLockFile: comp.farmLockFile,
        imagePackagesFile: comp.imagePackagesFile,
        bioKeys: comp.bioKeys,
        ...(comp.knowledge ? { knowledge: comp.knowledge } : {}),
        blockerHolder: ctx.blockerHolder,
        citationResolver: ctx.citationResolver,
        step: {
            sandbox: ctx.sandbox,
            workspaceRoot: comp.resolveWorkspaceRoot(ctx.input.analysisId),
            analysisId: ctx.input.analysisId,
            runId: ctx.input.runId,
            stepId: ctx.input.stepId,
            workflowId: ctx.workflowId,
            allowedWritePrefix: ctx.stepWritePrefix,
            nextFunctionId: ctx.nextFunctionId,
            deadlineMs: ctx.deadlineMs,
            ...(ctx.input.templateBinding ? { templateBinding: ctx.input.templateBinding } : {}),
        },
    };
    const agent = createSandboxAgents(deps)[ctx.input.agentId];
    if (agent === undefined) {
        const known = Object.keys(SANDBOX_AGENT_META).join(", ");
        throw new Error(`unknown sandbox agent id "${ctx.input.agentId}" — known catalog ids: ${known}`);
    }
    return agent;
}

/** One inner provider per distinct connection, then one recording wrapper per role. */
async function buildRoleProviders(
    connections: Readonly<Record<EvalRole, ModelConnection>>,
    calls: JsonlSink,
): Promise<Readonly<Record<EvalRole, ChatProvider>>> {
    const inners = new Map<string, ChatProvider>();
    const innerFor = async (connection: ModelConnection): Promise<ChatProvider> => {
        const key = JSON.stringify(connection);
        const existing = inners.get(key);
        if (existing) return existing;
        const built = await buildProvider(connection);
        inners.set(key, built);
        return built;
    };
    return {
        planner: recordingProvider(await innerFor(connections.planner), "planner", calls),
        sandbox: recordingProvider(await innerFor(connections.sandbox), "sandbox", calls),
        utility: recordingProvider(await innerFor(connections.utility), "utility", calls),
    };
}

/**
 * Build the deps, boot the harness on the campaign database, and give the
 * booted runtime back with the seams the runner drives. The caller wires
 * `shutdown` to its exit path.
 */
export async function composeEvalRuntime(options: EvalRuntimeOptions): Promise<EvalRuntime> {
    if (options.condition === "with" && options.knowledge === undefined) {
        throw new Error("the with arm needs a knowledge client");
    }
    const knowledge = options.condition === "with" ? options.knowledge : undefined;
    const logger = options.logger ?? createConsoleLogger();
    const skillsDir = options.skillsDir ?? DEFAULT_SKILLS_DIR;
    const resourcePolicy = options.resourcePolicy ?? defaultResourcePolicy();

    const calls = createJsonlSink(join(options.attemptDir, "calls.jsonl"));
    const recorder = createEvalUsageRecorder(join(options.attemptDir, "usage.jsonl"));
    const providers = await buildRoleProviders(options.connections, calls);
    const models: Readonly<Record<EvalRole, string>> = {
        planner: options.connections.planner.model,
        sandbox: options.connections.sandbox.model,
        utility: options.connections.utility.model,
    };

    await ensureCampaignDatabase(options.pgUrl);
    const conn = parsePgUrl(options.pgUrl);
    const pool = createPool({ host: conn.host, port: conn.port, database: conn.database, user: conn.user, password: conn.password, sslMode: "disable" });

    try {
        const embedding = createEmbeddingProvider({
            baseURL: options.embedding.baseUrl,
            token: options.embedding.apiKey,
            ...(options.embedding.model ? { model: options.embedding.model } : {}),
            ...(options.embedding.dimensions ? { dimensions: options.embedding.dimensions } : {}),
            resolveBilling: createNoopBillingResolver(),
        });
        const resolveWorkspaceRoot: ResolveWorkspaceRoot = (analysisId) => readWorkspaceRoot(options.campaignDir, analysisId);
        const farmPath = join(options.sandbox.storeDir, "farms", "catalog");
        const farmLockFile = join(farmPath, FARM_LOCK_FILE);
        const imagePackagesFile = join(options.sandbox.storeDir, IMAGE_PACKAGES_FILE);
        const sandboxClient = createSandboxClient({
            pool,
            env: { backend: "docker", namespace: "" },
            transport: "poll",
            // Poll mode: the sandbox never dials out, thus the harness ignores the URL.
            cortexBaseUrl: "",
            image: options.sandbox.image,
            libStorePath: options.sandbox.storeDir,
            farmSource: { kind: "fixed", location: { farmPath } },
            toolchainSource: "image",
            packageStore: "required",
            refStorePath: options.sandbox.refsDir,
            resourceLimits: resourcePolicy.perStep,
            resolveWorkspaceRoot,
            logger,
            ...(options.sandbox.engineSocketPath ? { engineSocketPath: options.sandbox.engineSocketPath } : {}),
            ...(options.sandbox.engineBindOwnership ? { engineBindOwnership: options.sandbox.engineBindOwnership } : {}),
        });
        const workspaceFs = createWorkspaceFilesystem({ resolveWorkspaceRoot });
        const runAuthorizer = createLocalRunAuthorizer();
        const runLauncher = createDbosRunLauncher();

        const composition: EvalComposition = {
            pool,
            logger,
            embedding,
            sandboxClient,
            workspaceFs,
            resolveWorkspaceRoot,
            sandbox: { provider: providers.sandbox, model: models.sandbox },
            skillsDir,
            refStorePath: options.sandbox.refsDir,
            farmLockFile,
            imagePackagesFile,
            bioKeys: NO_BIO_KEYS,
            ...(knowledge ? { knowledge } : {}),
        };

        const workflows: CoreWorkflowDeps = {
            sandboxStep: {
                pool,
                logger,
                provider: providers.sandbox,
                embedding,
                sandboxClient,
                artifactRegistry: createNoopArtifactRegistry(),
                workspaceFs,
                resolveWorkspaceRoot,
                model: models.sandbox,
                buildAgent: (ctx) => buildStepAgent(composition, ctx),
                resolveWritePrefix: (input: SandboxStepInput) => join(resolveWorkspaceRoot(input.analysisId), runStepDir(input.runId, input.stepId)),
            },
            buildExecuteAnalysis: (sandboxStep) => ({
                logger,
                pool,
                provider: providers.sandbox,
                embedding,
                sandboxStepCallable: sandboxStep,
                resolveWorkspaceRoot,
                synthesisModel: models.sandbox,
                bioKeys: NO_BIO_KEYS,
                runCharge: createNoopRunCharge(),
                runAuthorizer,
                ...(knowledge ? { knowledge } : {}),
            }),
            executeTargetAssessment: {
                pool,
                runAuthorizer,
                chatProvider: providers.sandbox,
                decisionModel: models.sandbox,
                synthesisModel: models.sandbox,
            },
            dataProfile: {
                logger,
                provider: providers.sandbox,
                pool,
                sandboxClient,
                workspaceFs,
                resolveWorkspaceRoot,
                model: models.sandbox,
                runAuthorizer,
                bioKeys: NO_BIO_KEYS,
                embedding,
                skillsDir,
                refStorePath: options.sandbox.refsDir,
                farmLockFile,
                imagePackagesFile,
            },
        };

        const conversation: ConversationAssemblyDeps = {
            logger,
            provider: providers.planner,
            utilityProvider: providers.utility,
            pool,
            embedding,
            workspaceFs,
            model: models.planner,
            utilityModel: models.utility,
            resolveWorkspaceRoot,
            runAuthorizer,
            runLauncher,
            bioKeys: NO_BIO_KEYS,
            ...(knowledge ? { knowledge } : {}),
            skillsDir,
            refStorePath: options.sandbox.refsDir,
            farmLockFile,
            imagePackagesFile,
            chrome: {},
            hostTools: knowledge ? [createKnowledgeRecommendTool({ client: knowledge, farmLockFile, refStorePath: options.sandbox.refsDir })] : [],
        };

        const adminPort = options.adminPort ?? (await freePort());
        const booted = await bootHarness({
            core: { conversation, workflows, resourcePolicy, usageRecorder: recorder },
            pool,
            skillsDir,
            dbos: {
                dbHost: conn.host,
                dbPort: conn.port,
                dbName: conn.database,
                dbUser: conn.user,
                dbPassword: conn.password,
                dbSslMode: "disable",
                appName: "inflexa-eval",
                adminPort: String(adminPort),
                executorId: `eval-${options.campaign}`,
                logLevel: "warn",
            },
            connectionBudget: {},
            logger,
            initTelemetry: () => {},
            exit: () => {},
        });

        return {
            runtime: booted.runtime,
            shutdown: booted.shutdown,
            pool,
            providers,
            models,
            recorder,
            sinks: { calls, usage: recorder.sink },
            composition,
            runAuthorizer,
            runLauncher,
            ...(knowledge ? { knowledge } : {}),
            setAttemptDir(dir: string): void {
                calls.retarget(join(dir, "calls.jsonl"));
                recorder.sink.retarget(join(dir, "usage.jsonl"));
            },
        };
    } catch (caught) {
        await pool.end().catch(() => {});
        throw caught;
    }
}
