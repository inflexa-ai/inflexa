import { resolve } from "node:path";
import { validatePath } from "@inflexa-ai/harness/tools/lib/path-validation";
import { Hono, type Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import {
    EMBEDDING_API_KEY_HEADER,
    type AgentList,
    type AgentName,
    type AgentView,
    type EmbeddingModelList,
    type MachineSandboxReadiness,
    type MeView,
    type ModelList,
    type OpenFolderBody,
    type OpenFolderResult,
    type PutAgentResponse,
    type ServerSettings,
    type SettingsPatch,
} from "../../api/machine.ts";
import { AGENT_EFFORTS, readConfig, resolvePostgresConfig, writeConfig, type Config, type ConfigError } from "../../lib/config.ts";
import { runtimeIds } from "../../lib/container.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { env, isReservedPostgresPort } from "../../lib/env.ts";
import { errnoCode, mkdirResultAsync, pathExistsAsync, statResultAsync } from "../../lib/fs.ts";
import { getLogger } from "../../lib/log.ts";
import { openExternal, type OpenExternalError } from "../../lib/open_external.ts";
import { findAnalysis } from "../../modules/analysis/analysis.ts";
import { classifyRealPath, workspaceReadRoot } from "../../modules/analysis/boundary.ts";
import { resolveInputPath } from "../../modules/analysis/input.ts";
import { locateOrEnsureOutputDir } from "../../modules/analysis/output.ts";
import { describeAuthError, loadAuth } from "../../modules/auth/auth.ts";
import { decodeIdTokenClaims } from "../../modules/auth/whoami.ts";
import { listEmbeddingModels, type EmbeddingModelListError } from "../../modules/embedding/api_models.ts";
import { LOCAL_EMBEDDING_DIMENSIONS } from "../../modules/embedding/local-provider.ts";
import { DEFAULT_API_BASE_URL, DEFAULT_API_EMBEDDING_DIMENSIONS } from "../../modules/embedding/resolve.ts";
import { currentAgentEfforts, currentAgentModels, pendingAgentSelections, requestAgentModelChange } from "../../modules/harness/agent_switch.ts";
import { AGENT_NAMES, writeAgentSelection } from "../../modules/harness/config.ts";
import {
    describeListModelsError,
    listConnectionModels,
    validateModelSelection,
    type ListedModel,
    type ListModelsError,
} from "../../modules/harness/model_listing.ts";
import { explicitPostgresFields } from "../../modules/infra/setup.ts";
import type { ModelAccess } from "../../modules/proxy/models.ts";
import { apiError, holdConnection, internalError, readBody, type ServerEnv } from "../http.ts";
import { readMachineSandboxReadiness } from "../sandbox_gate.ts";

/** The upper bound of the model probe of an embedding endpoint. A hung endpoint must not hold the request. */
const EMBEDDING_MODELS_TIMEOUT_MS = 10_000;

/** The connection reads and writes of the machine routes. Tests replace each one. */
export type MachineRouteOpts = {
    readonly listModels: () => Promise<Result<ListedModel[], ListModelsError>>;
    readonly validateModel: (model: string) => Promise<ModelAccess>;
    readonly listEmbeddingModels: (baseUrl: string, apiKey: string, signal: AbortSignal) => Promise<Result<string[], EmbeddingModelListError>>;
    readonly sandboxReadiness: () => Promise<MachineSandboxReadiness>;
    readonly openExternal: (target: string) => Result<void, OpenExternalError>;
};

/** The production {@link MachineRouteOpts}. */
export const DEFAULT_MACHINE_ROUTE_OPTS: MachineRouteOpts = {
    listModels: () => listConnectionModels(),
    validateModel: (model) => validateModelSelection(model),
    listEmbeddingModels,
    sandboxReadiness: () => readMachineSandboxReadiness(),
    openExternal,
};

const putAgentBody = z.object({
    model: z.string().trim().min(1),
    effort: z.enum(AGENT_EFFORTS),
});

const patchSettingsBody = z
    .object({
        telemetry: z.boolean(),
        runtime: z.enum(runtimeIds).nullable(),
        postgres: z.object({
            host: z.string().trim().min(1),
            port: z
                .number()
                .int()
                .min(1)
                .max(65535)
                // `config.json` is shared by both build channels, and a reserved channel default would be dropped at
                // read time, thus it is refused here with the reason. The default of this channel passes: a client
                // sends the resolved connection back, and the write drops that port (`explicitPostgresFields`).
                .refine(
                    (port) => port === env.postgresPort || !isReservedPostgresPort(port),
                    "A reserved default port (prod 8432, dev 8434) cannot be pinned in config.json.",
                ),
            database: z.string().trim().min(1),
            user: z.string().trim().min(1),
            password: z.string().min(1).optional(),
        }),
        embedding: z.discriminatedUnion("mode", [
            z.object({ mode: z.literal("off") }),
            z.object({ mode: z.literal("local"), modelPath: z.string().min(1), dimensions: z.number().int().positive().optional() }),
            z.object({
                mode: z.literal("api-key"),
                apiKey: z.string().min(1).optional(),
                baseURL: z.string().min(1).optional(),
                model: z.string().min(1).optional(),
                dimensions: z.number().int().positive().optional(),
            }),
        ]),
    })
    .partial();

/** The known folders of `POST /open-directory`. The body names a target, never a path that the server opens outside a jail. */
const openFolderBody = z.discriminatedUnion("target", [
    z.object({ target: z.literal("data_dir") }),
    z.object({ target: z.literal("output_dir"), analysisId: z.string().min(1) }),
    z.object({ target: z.literal("workspace"), analysisId: z.string().min(1), path: z.string() }),
    z.object({ target: z.literal("input"), analysisId: z.string().min(1), path: z.string(), anchorId: z.string().min(1).nullable() }),
    z.object({ target: z.literal("logs_dir") }),
    z.object({ target: z.literal("reference_store") }),
    z.object({ target: z.literal("package_store") }),
]) satisfies z.ZodType<OpenFolderBody>;

/** The `stat` codes that mean the resolved candidate is absent: no entry, a part of the path is not a folder, or the links loop. */
const ABSENT_STAT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/**
 * The routes of the machine (draft 2.1 and 2.6) that are not the package store: the signed-in account, the
 * models and the efforts of the agents, the models of the connection, the server keys of the config, the sandbox
 * readiness of the machine (`GET /sandbox`), and the open of a known folder in the file manager (`POST /open-directory`).
 * None of them needs the runtime: a model switch with no runtime applies at the next boot.
 */
export function machineRoutes(opts: MachineRouteOpts = DEFAULT_MACHINE_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.get("/me", (c) =>
        c.json(
            loadAuth().match(
                (auth): MeView => {
                    const claims = decodeIdTokenClaims(auth.idToken);
                    return {
                        signedIn: true,
                        ...(claims?.name ? { name: claims.name } : {}),
                        ...(claims?.email ? { email: claims.email } : {}),
                        ...(claims?.sub ? { subject: claims.sub } : {}),
                        claimsDecoded: claims !== null,
                        expiresAt: new Date(auth.expiresAt).toISOString(),
                    };
                },
                (error): MeView => ({ signedIn: false, error: describeAuthError(error) }),
            ),
        ),
    );

    routes.get("/agents", (c) => {
        const body: AgentList = { agents: AGENT_NAMES.map(agentView) };
        return c.json(body);
    });

    routes.put("/agents/:role", async (c) => {
        holdConnection(c);
        const role = c.req.param("role");
        if (!isAgentName(role)) return apiError(c, "not_found", `No agent role "${role}". The roles are ${AGENT_NAMES.join(", ")}.`);
        const body = await readBody(c, putAgentBody);
        if (body.isErr()) return body.error;
        const selection = body.value;
        // Only a definite `not_found` refuses. An inconclusive check accepts, because a flaky or absent
        // validation route must never take the switch away.
        if ((await opts.validateModel(selection.model)) === "not_found") {
            return apiError(c, "validation_error", `This account cannot serve ${selection.model}. Pick another model, or check your credential.`, {
                fieldErrors: { model: ["not served"] },
            });
        }
        // The config is the durable truth, thus a failed write stops before a runtime change that it would disagree with.
        return writeAgentSelection(role, selection).match(
            () => {
                const outcome = requestAgentModelChange(role, selection);
                const response: PutAgentResponse = { agent: agentView(role), status: outcome.status };
                return c.json(response);
            },
            (e) => internalError(c, e, "save the agent selection"),
        );
    });

    routes.get("/models", async (c) => {
        holdConnection(c);
        // A listing that failed is an ordinary outcome: the client offers a free-text model id.
        const body: ModelList = (await opts.listModels()).match(
            (listed): ModelList => ({ models: listed.map((model) => ({ id: model.id, efforts: [...model.efforts], releasedAt: model.releasedAt })) }),
            (error): ModelList => ({ models: null, reason: describeListModelsError(error) }),
        );
        return c.json(body);
    });

    routes.get("/settings", (c) => c.json(serverSettings()));

    routes.patch("/settings", async (c) => {
        const body = await readBody(c, patchSettingsBody);
        if (body.isErr()) return body.error;
        const embedding = body.value.embedding;
        if (embedding?.mode === "api-key" && embedding.apiKey === undefined && readConfig().embedding.apiKey === undefined) {
            const message = "The config holds no api key, thus an `api-key` backend must send one.";
            return apiError(c, "validation_error", message, { formErrors: [], fieldErrors: { embedding: [message] } });
        }
        return saveSettings(body.value).match(
            () => c.json(serverSettings()),
            (e) => internalError(c, e, "save the settings"),
        );
    });

    routes.get("/embedding-models", async (c) => {
        holdConnection(c);
        const baseUrl = c.req.query("baseUrl") ?? DEFAULT_API_BASE_URL;
        const apiKey = c.req.header(EMBEDDING_API_KEY_HEADER);
        if (apiKey === undefined || apiKey.trim() === "") {
            return apiError(c, "validation_error", `Send the api key of the endpoint in the \`${EMBEDDING_API_KEY_HEADER}\` header.`);
        }
        // Each listing failure is an ordinary outcome: the client then asks for the model id.
        const listed = await opts.listEmbeddingModels(baseUrl, apiKey.trim(), AbortSignal.timeout(EMBEDDING_MODELS_TIMEOUT_MS));
        const body: EmbeddingModelList = listed.match(
            (models): EmbeddingModelList => ({ models }),
            (error): EmbeddingModelList => ({ models: null, reason: error.type }),
        );
        return c.json(body);
    });

    routes.get("/sandbox", async (c) => {
        holdConnection(c);
        return c.json(await opts.sandboxReadiness());
    });

    routes.post("/open-directory", async (c) => {
        const body = await readBody(c, openFolderBody);
        if (body.isErr()) return body.error;
        const folder = await folderForTarget(c, body.value);
        if (folder.isErr()) return folder.error;
        // The directories-only guard tests the resolved candidate of every target: an existence probe alone passes a file.
        const onDisk = await statResultAsync(folder.value, "openFolder");
        if (onDisk.isErr()) {
            if (!ABSENT_STAT_CODES.has(errnoCode(onDisk.error.cause) ?? "")) return internalError(c, onDisk.error, "stat the folder");
            return apiError(c, "not_found", `The folder ${folder.value} is not on disk.`);
        }
        if (!onDisk.value.isDirectory()) return apiError(c, "conflict", `${folder.value} is a file, and the endpoint opens directories only.`);
        const opened = opts.openExternal(folder.value);
        if (opened.isErr()) getLogger("server").warn({ code: opened.error.code, path: folder.value }, "could not open a folder in the file manager");
        return c.json({ opened: opened.isOk() } satisfies OpenFolderResult);
    });

    return routes;
}

/** The folder one target of `POST /open-directory` names, or the error response to send instead. */
async function folderForTarget(c: Context<ServerEnv>, requested: OpenFolderBody): Promise<Result<string, Response>> {
    switch (requested.target) {
        case "data_dir":
            return ok(env.dataDir);
        case "logs_dir":
            return ok(env.logDir);
        case "reference_store":
            return ensureStoreFolder(c, env.refsDir);
        case "package_store":
            return ensureStoreFolder(c, env.packageStoreDir);
        case "output_dir":
        case "workspace":
        case "input":
            return analysisFolder(c, requested);
        default: {
            const _exhaustive: never = requested;
            return _exhaustive;
        }
    }
}

/** The folder of a target that carries an `analysisId`: the analysis row must exist and match the id exactly. */
async function analysisFolder(
    c: Context<ServerEnv>,
    requested: Extract<OpenFolderBody, { target: "output_dir" | "workspace" | "input" }>,
): Promise<Result<string, Response>> {
    const analysis = findAnalysis(requested.analysisId);
    if (analysis.isErr()) return err(internalError(c, analysis.error, "read the analysis"));
    // `findAnalysis` also matches a name, and the body field is an id.
    if (analysis.value === null || analysis.value.id !== requested.analysisId) {
        return err(apiError(c, "not_found", `No analysis ${requested.analysisId}.`));
    }
    switch (requested.target) {
        case "output_dir":
            // The same folder as `POST {A}/output-dir`: an existing one as it is, else the server makes it.
            return (await locateOrEnsureOutputDir(analysis.value)).match(
                (dir) => ok(dir),
                (e) => (e.type === "workspace_unavailable" ? err(apiError(c, "conflict", e.message)) : err(internalError(c, e, "make the workspace folder"))),
            );
        case "workspace":
            return workspaceFolder(c, requested.analysisId, requested.path);
        case "input":
            return inputFolder(c, requested.analysisId, requested);
        default: {
            const _exhaustive: never = requested;
            return _exhaustive;
        }
    }
}

/**
 * The jailed `workspace` folder: the same rule as the `workspace-file` kind of `POST {A}/artifacts/resolve`.
 * A bad form is 400; an unresolvable root is 409; a path outside the workspace, also through a symbolic
 * link, is 404. An absent path returns its candidate, and the disk guard answers 404, also for a path
 * that is inside only as text.
 */
async function workspaceFolder(c: Context<ServerEnv>, analysisId: string, path: string): Promise<Result<string, Response>> {
    if (validatePath(path) !== null) {
        return err(apiError(c, "validation_error", "The `path` of a `workspace` target must be a relative path with no `..` segment."));
    }
    const root = await workspaceReadRoot(analysisId);
    if (root.isErr()) {
        return err(
            root.error.type === "workspace_unavailable"
                ? apiError(c, "conflict", root.error.message)
                : internalError(c, root.error, "resolve the workspace root"),
        );
    }
    const candidate = resolve(root.value.text, path);
    const verdict = await classifyRealPath([root.value], candidate);
    if (verdict.isErr()) return err(internalError(c, verdict.error, "resolve the workspace path"));
    if (verdict.value.type === "outside") {
        return err(apiError(c, "not_found", `The path ${path} resolves outside the workspace of the analysis.`));
    }
    return ok(candidate);
}

/**
 * The folder of one registered input, or the error for each refusal. The match is exact pair equality,
 * not `matchInputRefs`: a wrong anchor or a resolved-absolute match must never open. A file reference
 * is refused from the record alone, before any disk probe; a stale record that names a folder falls
 * through to the disk guard.
 */
async function inputFolder(
    c: Context<ServerEnv>,
    analysisId: string,
    reference: { path: string; anchorId: string | null },
): Promise<Result<string, Response>> {
    const inputs = listAnalysisInputs(analysisId);
    if (inputs.isErr()) return err(internalError(c, inputs.error, "read the inputs of the analysis"));
    const match = inputs.value.find((input) => input.path === reference.path && input.anchorId === reference.anchorId);
    if (match === undefined) return err(apiError(c, "not_found", "No registered input of the analysis matches the reference."));
    if (!match.isDir) return err(apiError(c, "conflict", `The registered input ${reference.path} is a file, and the endpoint opens directories only.`));
    const resolved = await resolveInputPath(match);
    if (resolved.isErr()) return err(internalError(c, resolved.error, "resolve the input path"));
    if (resolved.value === null) return err(apiError(c, "conflict", `The anchor of the registered input ${reference.path} cannot be found.`));
    return ok(resolved.value);
}

/** A store folder as it is, else made first. A file where the folder belongs reaches the disk guard. */
async function ensureStoreFolder(c: Context<ServerEnv>, dir: string): Promise<Result<string, Response>> {
    if (await pathExistsAsync(dir)) return ok(dir);
    const made = await mkdirResultAsync(dir, "openFolder");
    return made.isErr() ? err(internalError(c, made.error, "make the folder")) : ok(dir);
}

function isAgentName(role: string): role is AgentName {
    // The predicate is sound: it tests membership in the closed agent set.
    return (AGENT_NAMES as readonly string[]).includes(role);
}

/** One agent as the live switch has it. Before the runtime installs the switch, it has no current selection. */
function agentView(role: AgentName): AgentView {
    const efforts = currentAgentEfforts();
    return {
        role,
        current: efforts === null ? null : { model: currentAgentModels()[role], effort: efforts[role] },
        pending: pendingAgentSelections().get(role) ?? null,
    };
}

/** The server keys of the config, with the Postgres connection resolved and the embedding defaults. Each secret stays out: the body says only if it is set. */
function serverSettings(): ServerSettings {
    const config = readConfig();
    const { password: _password, ...postgres } = resolvePostgresConfig();
    const { apiKey, ...embedding } = config.embedding;
    return {
        telemetry: config.telemetry,
        runtime: config.runtime ?? null,
        postgres: { ...postgres, passwordSet: config.postgres?.password !== undefined },
        embedding: { ...embedding, apiKeySet: apiKey !== undefined },
        embeddingDefaults: {
            apiBaseUrl: DEFAULT_API_BASE_URL,
            apiDimensions: DEFAULT_API_EMBEDDING_DIMENSIONS,
            localDimensions: LOCAL_EMBEDDING_DIMENSIONS,
            builtinModelPath: env.embeddingModelPath,
        },
        dataDir: env.dataDir,
        serverLogPath: env.serverLogPath,
    };
}

/**
 * Write the keys of `patch` over the config. A Postgres field that equals its channel default is not
 * frozen into the file, because `config.json` is shared by both build channels, and an all-defaults
 * connection drops the `postgres` key (refer to `explicitPostgresFields`). A secret that the patch does not
 * send keeps its stored value, because no client has it.
 */
function saveSettings(patch: SettingsPatch): Result<void, ConfigError> {
    const config = readConfig();
    const embedding = patch.embedding?.mode === "api-key" ? { ...patch.embedding, apiKey: patch.embedding.apiKey ?? config.embedding.apiKey } : patch.embedding;
    const next: Config = {
        ...config,
        ...(patch.telemetry === undefined ? {} : { telemetry: patch.telemetry }),
        ...(patch.runtime === undefined ? {} : { runtime: patch.runtime ?? undefined }),
        ...(embedding === undefined ? {} : { embedding }),
    };
    if (patch.postgres !== undefined) {
        const explicit = explicitPostgresFields({ ...patch.postgres, password: patch.postgres.password ?? resolvePostgresConfig().password });
        next.postgres = Object.keys(explicit).length === 0 ? undefined : explicit;
    }
    return writeConfig(next);
}
