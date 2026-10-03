import { Hono } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";

import {
    EMBEDDING_API_KEY_HEADER,
    type AgentList,
    type AgentName,
    type AgentView,
    type EmbeddingModelList,
    type MeView,
    type ModelList,
    type PutAgentResponse,
    type ServerSettings,
    type SettingsPatch,
} from "../../api/machine.ts";
import { AGENT_EFFORTS, readConfig, resolvePostgresConfig, writeConfig, type Config, type ConfigError } from "../../lib/config.ts";
import { runtimeIds } from "../../lib/container.ts";
import { env, isReservedPostgresPort } from "../../lib/env.ts";
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

/** The upper bound of the model probe of an embedding endpoint. A hung endpoint must not hold the request. */
const EMBEDDING_MODELS_TIMEOUT_MS = 10_000;

/** The connection reads and writes of the machine routes. Tests replace each one. */
export type MachineRouteOpts = {
    readonly listModels: () => Promise<Result<ListedModel[], ListModelsError>>;
    readonly validateModel: (model: string) => Promise<ModelAccess>;
    readonly listEmbeddingModels: (baseUrl: string, apiKey: string, signal: AbortSignal) => Promise<Result<string[], EmbeddingModelListError>>;
};

/** The production {@link MachineRouteOpts}. */
export const DEFAULT_MACHINE_ROUTE_OPTS: MachineRouteOpts = {
    listModels: () => listConnectionModels(),
    validateModel: (model) => validateModelSelection(model),
    listEmbeddingModels,
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

/**
 * The routes of the machine (draft 2.1 and 2.6) that are not the package store: the signed-in account, the
 * models and the efforts of the agents, the models of the connection, and the server keys of the config. None
 * of them needs the runtime: a model switch with no runtime applies at the next boot.
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
            (listed): ModelList => ({ models: listed.map((model) => ({ id: model.id, efforts: [...model.efforts] })) }),
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

    return routes;
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
