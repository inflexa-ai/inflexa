import type { ResultAsync } from "neverthrow";

import {
    EMBEDDING_API_KEY_HEADER,
    type AgentList,
    type AgentName,
    type AgentSelection,
    type EmbeddingModelList,
    type MeView,
    type ModelList,
    type PutAgentResponse,
    type ServerSettings,
    type SettingsPatch,
} from "../api/machine.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/** `GET /api/v1/me`: the identity of the stored session of the server user. */
export function fetchMe(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<MeView, ClientError> {
    return request<MeView>("GET", "/api/v1/me", {}, opts);
}

/** `GET /api/v1/agents`: the model and the effort of each agent, and a selection that waits for idle. */
export function fetchAgents(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AgentList, ClientError> {
    return request<AgentList>("GET", "/api/v1/agents", {}, opts);
}

/**
 * `PUT /api/v1/agents/:role`: validate, save, and apply a model and an effort. 400 `validation_error` when the
 * account cannot serve the model; its message names the model.
 */
export function updateAgent(role: AgentName, selection: AgentSelection, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<PutAgentResponse, ClientError> {
    return request<PutAgentResponse>("PUT", `/api/v1/agents/${role}`, { body: selection }, opts);
}

/** `GET /api/v1/models`: the models of the connection, or `models: null` when the listing failed. */
export function fetchModels(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ModelList, ClientError> {
    return request<ModelList>("GET", "/api/v1/models", {}, opts);
}

/** `GET /api/v1/settings`: the server keys of the config. */
export function fetchSettings(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ServerSettings, ClientError> {
    return request<ServerSettings>("GET", "/api/v1/settings", {}, opts);
}

/** `PATCH /api/v1/settings`: replace server keys. They apply at the next boot of the runtime. */
export function updateSettings(patch: SettingsPatch, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ServerSettings, ClientError> {
    return request<ServerSettings>("PATCH", "/api/v1/settings", { body: patch }, opts);
}

/**
 * `GET /api/v1/embedding-models`: the embedding models of an OpenAI-compatible endpoint. The api key rides a
 * header, never the query string.
 */
export function fetchEmbeddingModels(
    baseUrl: string,
    apiKey: string,
    signal: AbortSignal,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<EmbeddingModelList, ClientError> {
    return request<EmbeddingModelList>(
        "GET",
        `/api/v1/embedding-models?baseUrl=${encodeURIComponent(baseUrl)}`,
        { signal, headers: { [EMBEDDING_API_KEY_HEADER]: apiKey } },
        opts,
    );
}
