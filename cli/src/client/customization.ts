import type { ResultAsync } from "neverthrow";

import type {
    AddMcpServerRequest,
    AgentDetail,
    FoundAgentList,
    ImportAgentRequest,
    AgentList,
    ConnectorList,
    ConnectorView,
    CredentialList,
    CredentialView,
    DeleteAgentResponse,
    DeleteCredentialResponse,
    ImportMcpServerRequest,
    InstallMcpServerRequest,
    McpCandidateList,
    RegistryServerList,
    RoleView,
    SkillDetail,
    DeleteMcpServerResponse,
    McpAuthResponse,
    McpLogoutResponse,
    McpServerList,
    McpServerView,
    PatchAgentRequest,
    PatchConnectorRequest,
    PutCredentialRequest,
    SkillList,
    SkillView,
} from "../api/customization.ts";
import { DEFAULT_CLIENT_OPTS, request, type ClientError, type ClientOpts } from "./api.ts";

/** `GET /api/v1/catalog/agents`: each built-in agent, each custom agent, and each draft, with the gaps. */
export function fetchAgents(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AgentList, ClientError> {
    return request<AgentList>("GET", "/api/v1/catalog/agents", {}, opts);
}

/** `GET /api/v1/catalog/agents/:id`: one agent with its prompt. 404 `not_found` for an unknown id. */
export function fetchAgent(id: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AgentDetail, ClientError> {
    return request<AgentDetail>("GET", `/api/v1/catalog/agents/${encodeURIComponent(id)}`, {}, opts);
}

/** `POST /api/v1/catalog/agents/:id/clone`: copy a built-in executor into a new agent file. 409 `conflict` for a taken id. */
export function cloneAgent(id: string, newId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AgentDetail, ClientError> {
    return request<AgentDetail>("POST", `/api/v1/catalog/agents/${encodeURIComponent(id)}/clone`, { body: { newId } }, opts);
}

/** `GET /api/v1/catalog/agents/found`: the agent files in the agent directories of other harnesses. */
export function fetchFoundAgents(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<FoundAgentList, ClientError> {
    return request<FoundAgentList>("GET", "/api/v1/catalog/agents/found", {}, opts);
}

/** `POST /api/v1/catalog/agents/import`: convert the agent file of another harness. `path` is absolute. Absent `role`: `executor`. */
export function importAgent(path: string, role: string | undefined, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AgentDetail, ClientError> {
    const body: ImportAgentRequest = role === undefined ? { path } : { path, role };
    return request<AgentDetail>("POST", "/api/v1/catalog/agents/import", { body }, opts);
}

/** `PATCH /api/v1/catalog/agents/:id`: turn an agent on or off, or attach or detach a connector, an MCP server, or a skill. */
export function patchAgent(id: string, body: PatchAgentRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<AgentDetail, ClientError> {
    return request<AgentDetail>("PATCH", `/api/v1/catalog/agents/${encodeURIComponent(id)}`, { body }, opts);
}

/** `DELETE /api/v1/catalog/agents/:id`: delete a custom agent file. 403 `forbidden` for a built-in agent. */
export function deleteAgent(id: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<DeleteAgentResponse, ClientError> {
    return request<DeleteAgentResponse>("DELETE", `/api/v1/catalog/agents/${encodeURIComponent(id)}`, {}, opts);
}

/** `GET /api/v1/skills`: the built-in and the custom skills, and each skill directory that the store leaves out. */
export function fetchSkills(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<SkillList, ClientError> {
    return request<SkillList>("GET", "/api/v1/skills", {}, opts);
}

/** `GET /api/v1/skills?dir=<dir>`: the skills in a directory that the user names. `dir` is absolute. */
/** `GET /api/v1/skills/:name`: one skill with its text and the paths of its other files. */
export function fetchSkill(name: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<SkillDetail, ClientError> {
    return request<SkillDetail>("GET", `/api/v1/skills/${encodeURIComponent(name)}`, {}, opts);
}

/** `GET /api/v1/skills/found`: the skills in the usual skill directories of other harnesses. */
export function fetchFoundSkills(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<SkillList, ClientError> {
    return request<SkillList>("GET", "/api/v1/skills/found", {}, opts);
}

export function findSkills(dir: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<SkillList, ClientError> {
    return request<SkillList>("GET", `/api/v1/skills?dir=${encodeURIComponent(dir)}`, {}, opts);
}

/** `POST /api/v1/skills/import`: copy one skill directory into the custom skills. `path` is absolute. */
export function importSkill(path: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<SkillView, ClientError> {
    return request<SkillView>("POST", "/api/v1/skills/import", { body: { path } }, opts);
}

/** `GET /api/v1/connectors`: each connector with its settings and the state of each credential slot. */
export function fetchConnectors(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ConnectorList, ClientError> {
    return request<ConnectorList>("GET", "/api/v1/connectors", {}, opts);
}

/** `PATCH /api/v1/connectors/:id`: change the settings of one connector. */
export function patchConnector(id: string, body: PatchConnectorRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ConnectorView, ClientError> {
    return request<ConnectorView>("PATCH", `/api/v1/connectors/${encodeURIComponent(id)}`, { body }, opts);
}

/** `GET /api/v1/credentials`: each credential of the config and whether it gives a value. Never a value. */
export function fetchCredentials(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<CredentialList, ClientError> {
    return request<CredentialList>("GET", "/api/v1/credentials", {}, opts);
}

/** `PUT /api/v1/credentials/:name`: declare where the value of a credential comes from. */
export function putCredential(name: string, body: PutCredentialRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<CredentialView, ClientError> {
    return request<CredentialView>("PUT", `/api/v1/credentials/${encodeURIComponent(name)}`, { body }, opts);
}

/** `GET /api/v1/mcp`: each MCP server of the config, valid or with its problem. */
export function fetchMcpServers(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<McpServerList, ClientError> {
    return request<McpServerList>("GET", "/api/v1/mcp", {}, opts);
}

/** `POST /api/v1/mcp`: add an MCP server. 409 `conflict` for a taken name. */
export function addMcpServer(body: AddMcpServerRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<McpServerView, ClientError> {
    return request<McpServerView>("POST", "/api/v1/mcp", { body }, opts);
}

/** `PATCH /api/v1/mcp/:name`: turn an MCP server on or off. */
export function patchMcpServer(name: string, enabled: boolean, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<McpServerView, ClientError> {
    return request<McpServerView>("PATCH", `/api/v1/mcp/${encodeURIComponent(name)}`, { body: { enabled } }, opts);
}

/** `DELETE /api/v1/mcp/:name`: remove an MCP server, with its tokens. */
export function deleteMcpServer(name: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<DeleteMcpServerResponse, ClientError> {
    return request<DeleteMcpServerResponse>("DELETE", `/api/v1/mcp/${encodeURIComponent(name)}`, {}, opts);
}

/** `POST /api/v1/mcp/:name/auth`: sign in to an MCP server in the browser. The response comes when the person finishes. */
export function signInMcpServer(name: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<McpAuthResponse, ClientError> {
    return request<McpAuthResponse>("POST", `/api/v1/mcp/${encodeURIComponent(name)}/auth`, {}, opts);
}

/** `DELETE /api/v1/mcp/:name/auth`: delete the stored tokens of an MCP server. */
export function signOutMcpServer(name: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<McpLogoutResponse, ClientError> {
    return request<McpLogoutResponse>("DELETE", `/api/v1/mcp/${encodeURIComponent(name)}/auth`, {}, opts);
}

/** `PUT /api/v1/catalog/roles/:role`: make an agent the active agent of its role. */
export function chooseRoleAgent(role: string, agentId: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<RoleView, ClientError> {
    return request<RoleView>("PUT", `/api/v1/catalog/roles/${encodeURIComponent(role)}`, { body: { agentId } }, opts);
}

/** `DELETE /api/v1/credentials/:name`: remove a credential and its stored value. */
export function deleteCredential(name: string, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<DeleteCredentialResponse, ClientError> {
    return request<DeleteCredentialResponse>("DELETE", `/api/v1/credentials/${encodeURIComponent(name)}`, {}, opts);
}

/** `GET /api/v1/mcp/found`: the MCP servers in the configs of other harnesses, with no value. */
export function fetchMcpCandidates(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<McpCandidateList, ClientError> {
    return request<McpCandidateList>("GET", "/api/v1/mcp/found", {}, opts);
}

/** `POST /api/v1/mcp/import`: copy a server of a different harness, with each value as a stored credential. */
export function importMcpServer(body: ImportMcpServerRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<McpServerView, ClientError> {
    return request<McpServerView>("POST", "/api/v1/mcp/import", { body }, opts);
}

/** `GET /api/v1/mcp/registry`: a page of the official MCP Registry. */
export function searchMcpRegistry(
    search: string,
    cursor: string | undefined,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): ResultAsync<RegistryServerList, ClientError> {
    const query = new URLSearchParams({ search });
    if (cursor !== undefined) query.set("cursor", cursor);
    return request<RegistryServerList>("GET", `/api/v1/mcp/registry?${query.toString()}`, {}, opts);
}

/** `POST /api/v1/mcp/install`: add a server of the MCP Registry, with each secret input as a stored credential. */
export function installMcpServer(body: InstallMcpServerRequest, opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<McpServerView, ClientError> {
    return request<McpServerView>("POST", "/api/v1/mcp/install", { body }, opts);
}
