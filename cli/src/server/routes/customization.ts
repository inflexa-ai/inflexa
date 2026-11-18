import { AGENT_ROLES } from "@inflexa-ai/harness";
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
    ATTACHMENT_KINDS,
    type AgentDetail,
    type AgentList,
    type DeleteCredentialResponse,
    type ExportSkillResponse,
    type FoundAgentList,
    type McpCandidateList,
    type RegistryServerList,
    type RoleView,
    type SkillDetail,
    type ConnectorList,
    type ConnectorView,
    type CredentialList,
    type CredentialView,
    type DeleteAgentResponse,
    type DeleteMcpServerResponse,
    type McpAuthResponse,
    type McpLogoutResponse,
    type McpServerList,
    type McpServerView,
    type SkillList,
    type SkillView,
} from "../../api/customization.ts";
import type { ApiErrorCode } from "../../api/common.ts";
import { mcpServerEntrySchema } from "../../lib/config.ts";
import { customizationErrorMessage, type CustomizationError, type CustomizationService, type ImportOptions } from "../../modules/customization/service.ts";
import { apiError, holdConnection, internalError, readBody, type ServerEnv } from "../http.ts";

const attachmentChangeSchema = z.object({ kind: z.enum(ATTACHMENT_KINDS), name: z.string().min(1) });

/** The body of `PATCH /catalog/agents/:id`. A `description` and a `prompt` apply to a custom agent only: a built-in agent is read-only. */
const patchAgentBody = z.object({
    enabled: z.boolean().optional(),
    attach: attachmentChangeSchema.optional(),
    detach: attachmentChangeSchema.optional(),
    description: z.string().trim().min(1).optional(),
    prompt: z.string().optional(),
    promptPath: z.string().min(1).optional(),
    analysis: z.string().min(1).optional(),
});

const cloneAgentBody = z.object({ newId: z.string(), description: z.string().trim().min(1).optional() });
const importOptions = { analysis: z.string().min(1).optional(), replace: z.boolean().optional() };
const importBody = z.object({ path: z.string().min(1), ...importOptions });
const importAgentBody = z.object({ path: z.string().min(1), role: z.string().optional(), ...importOptions });
const patchConnectorBody = z.object({
    endpoint: z.string().nullable().optional(),
    credentials: z.record(z.string(), z.string().nullable()).optional(),
});
const addMcpBody = z.object({ name: z.string(), entry: mcpServerEntrySchema });
const patchMcpBody = z.object({ enabled: z.boolean() });
const chooseRoleBody = z.object({ agentId: z.string().min(1) });
const putCredentialBody = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("env"), var: z.string().min(1) }),
    z.object({
        kind: z.literal("command"),
        command: z.string().min(1),
        format: z.enum(["raw", "exec-credential"]).optional(),
        ttlMs: z.number().int().positive().optional(),
    }),
    z.object({ kind: z.literal("stored"), value: z.string().min(1) }),
]);
const importMcpBody = z.object({ sourcePath: z.string().min(1), name: z.string().min(1), as: z.string().min(1).optional() });
const installMcpBody = z.object({
    registryName: z.string().min(1),
    version: z.string().min(1),
    install: z.number().int().nonnegative(),
    name: z.string().min(1),
    inputs: z.record(z.string(), z.string()),
});

/** The code of each {@link CustomizationError} that a client can act on. `null` marks a failure of the server itself. */
function codeOf(e: CustomizationError): ApiErrorCode | null {
    switch (e.type) {
        case "unknown_agent":
        case "unknown_connector":
        case "unknown_mcp_server":
        case "skill_dir_missing":
        case "unknown_skill":
        case "unknown_credential":
        case "unknown_candidate":
            return "not_found";
        case "agent_exists":
        case "skill_exists":
        case "path_exists":
        case "mcp_server_exists":
            return "conflict";
        case "cannot_disable":
        case "builtin_agent":
            return "forbidden";
        case "invalid_agent_id":
        case "draft_unreadable":
        case "unknown_reference":
        case "approval_needs_a_person":
        case "import_failed":
        case "invalid_skill":
        case "linked_entry":
        case "too_many_files":
        case "path_outside_workspace":
        case "prompt_file_too_large":
        case "unknown_slot":
        case "invalid_credential_name":
        case "invalid_mcp_name":
        case "invalid_mcp_entry":
        case "mcp_server_invalid":
        case "not_oauth":
        case "unknown_role":
        case "role_mismatch":
        case "unknown_install":
        case "missing_input":
            return "validation_error";
        case "sign_in_failed":
        case "registry_unavailable":
        case "workspace_unavailable":
            return "unavailable";
        case "io_failed":
        case "config_write_failed":
            return null;
        default: {
            const _exhaustive: never = e;
            return _exhaustive;
        }
    }
}

/** The options of an import body. */
function importOptionsOf(body: { readonly analysis?: string | undefined; readonly replace?: boolean | undefined }): ImportOptions {
    return { analysis: body.analysis, replace: body.replace };
}

function customizationError(c: Context, e: CustomizationError): Response {
    const code = codeOf(e);
    return code === null ? internalError(c, e, customizationErrorMessage(e)) : apiError(c, code, customizationErrorMessage(e));
}

/**
 * The customization routes under `/api/v1`: the agents, the skills, the connectors, the credentials, and the MCP
 * servers. Each route reads the files and the config again, thus a change applies with no restart of the server.
 */
export function customizationRoutes(service: CustomizationService): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.get("/catalog/agents", async (c) =>
        (await service.listAgents()).match(
            (list) => c.json(list satisfies AgentList),
            (e) => customizationError(c, e),
        ),
    );

    // The agent files in the agent directories of other harnesses. The read never writes.
    routes.get("/catalog/agents/found", async (c) =>
        (await service.findAgents()).match(
            (list) => c.json(list satisfies FoundAgentList),
            (e) => customizationError(c, e),
        ),
    );

    routes.post("/catalog/agents/import", async (c) => {
        const body = await readBody(c, importAgentBody);
        if (body.isErr()) return body.error;
        const wanted = body.value.role ?? "executor";
        const role = AGENT_ROLES.find((candidate) => candidate === wanted);
        if (role === undefined) return apiError(c, "validation_error", `No role "${wanted}". A role is one of: ${AGENT_ROLES.join(", ")}.`);
        return (await service.importAgent(body.value.path, role, importOptionsOf(body.value))).match(
            (agent) => c.json(agent satisfies AgentDetail, 201),
            (e) => customizationError(c, e),
        );
    });

    routes.get("/catalog/agents/:id", async (c) =>
        (await service.showAgent(c.req.param("id"))).match(
            (agent) => c.json(agent satisfies AgentDetail),
            (e) => customizationError(c, e),
        ),
    );

    routes.post("/catalog/agents/:id/clone", async (c) => {
        const body = await readBody(c, cloneAgentBody);
        if (body.isErr()) return body.error;
        return (await service.cloneAgent(c.req.param("id"), body.value.newId, body.value.description)).match(
            (agent) => c.json(agent satisfies AgentDetail, 201),
            (e) => customizationError(c, e),
        );
    });

    // The fields apply in a fixed order: `enabled`, then `description` and `prompt`, then `attach`, then `detach`. A body with no field reads the agent.
    routes.patch("/catalog/agents/:id", async (c) => {
        const id = c.req.param("id");
        const body = await readBody(c, patchAgentBody);
        if (body.isErr()) return body.error;
        const { enabled, attach, detach, description, prompt, promptPath, analysis } = body.value;
        if (prompt !== undefined && promptPath !== undefined) return apiError(c, "validation_error", "Give a prompt or a prompt file, not both.");
        const edits = description !== undefined || prompt !== undefined || promptPath !== undefined;
        if (edits) {
            const current = await service.showAgent(id);
            if (current.isErr()) return customizationError(c, current.error);
            if (current.value.kind === "builtin")
                return apiError(
                    c,
                    "forbidden",
                    `The built-in agent "${id}" is read-only. \`inflexa agent clone ${id} <new-id>\` makes a copy that you can edit.`,
                );
        }
        let result = enabled === undefined ? service.showAgent(id) : service.setAgentEnabled(id, enabled);
        if (edits) result = result.andThen(() => service.editAgent(id, { description, prompt, promptPath, analysis }));
        if (attach !== undefined) result = result.andThen(() => service.attach(id, attach.kind, attach.name));
        if (detach !== undefined) result = result.andThen(() => service.detach(id, detach.kind, detach.name));
        return (await result).match(
            (agent) => c.json(agent satisfies AgentDetail),
            (e) => customizationError(c, e),
        );
    });

    // The built-in agent of the role clears the choice.
    routes.put("/catalog/roles/:role", async (c) => {
        const body = await readBody(c, chooseRoleBody);
        if (body.isErr()) return body.error;
        return (await service.chooseRoleAgent(c.req.param("role"), body.value.agentId)).match(
            (role) => c.json(role satisfies RoleView),
            (e) => customizationError(c, e),
        );
    });

    routes.delete("/catalog/agents/:id", async (c) =>
        (await service.removeAgent(c.req.param("id"))).match(
            () => c.json({ deleted: true } satisfies DeleteAgentResponse),
            (e) => customizationError(c, e),
        ),
    );

    // With `dir`, the skills of a directory that the user names, for `inflexa skill find`. The read never writes.
    routes.get("/skills", async (c) => {
        const dir = c.req.query("dir");
        return (await (dir === undefined || dir.length === 0 ? service.listSkills() : service.findSkills(dir))).match(
            (list) => c.json(list satisfies SkillList),
            (e) => customizationError(c, e),
        );
    });

    // The skills in the usual skill directories of other harnesses. The read never writes.
    routes.get("/skills/found", async (c) =>
        (await service.findSkills(undefined)).match(
            (list) => c.json(list satisfies SkillList),
            (e) => customizationError(c, e),
        ),
    );

    routes.get("/skills/:name", async (c) =>
        (await service.showSkill(c.req.param("name"))).match(
            (skill) => c.json(skill satisfies SkillDetail),
            (e) => customizationError(c, e),
        ),
    );

    routes.post("/skills/:name/export", async (c) => {
        const body = await readBody(c, importBody);
        if (body.isErr()) return body.error;
        return (await service.exportSkill(c.req.param("name"), body.value.path, importOptionsOf(body.value))).match(
            (exported) => c.json(exported satisfies ExportSkillResponse, 201),
            (e) => customizationError(c, e),
        );
    });

    routes.post("/skills/import", async (c) => {
        const body = await readBody(c, importBody);
        if (body.isErr()) return body.error;
        return (await service.importSkill(body.value.path, importOptionsOf(body.value))).match(
            (skill) => c.json(skill satisfies SkillView, 201),
            (e) => customizationError(c, e),
        );
    });

    routes.get("/connectors", async (c) =>
        (await service.listConnectors()).match(
            (connectors) => c.json({ connectors } satisfies ConnectorList),
            (e) => customizationError(c, e),
        ),
    );

    routes.patch("/connectors/:id", async (c) => {
        const body = await readBody(c, patchConnectorBody);
        if (body.isErr()) return body.error;
        return (await service.setConnector(c.req.param("id"), body.value)).match(
            (connector) => c.json(connector satisfies ConnectorView),
            (e) => customizationError(c, e),
        );
    });

    routes.get("/credentials", async (c) =>
        (await service.listCredentials()).match(
            (credentials) => c.json({ credentials } satisfies CredentialList),
            (e) => customizationError(c, e),
        ),
    );

    routes.put("/credentials/:name", async (c) => {
        const body = await readBody(c, putCredentialBody);
        if (body.isErr()) return body.error;
        return (await service.setCredential(c.req.param("name"), body.value)).match(
            (credential) => c.json(credential satisfies CredentialView),
            (e) => customizationError(c, e),
        );
    });

    routes.delete("/credentials/:name", async (c) =>
        (await service.removeCredential(c.req.param("name"))).match(
            () => c.json({ deleted: true } satisfies DeleteCredentialResponse),
            (e) => customizationError(c, e),
        ),
    );

    // The MCP servers in the configs of other harnesses on this machine. The values of their env and headers stay here.
    routes.get("/mcp/found", async (c) =>
        (await service.findMcp()).match(
            (candidates) => c.json({ candidates } satisfies McpCandidateList),
            (e) => customizationError(c, e),
        ),
    );

    routes.post("/mcp/import", async (c) => {
        const body = await readBody(c, importMcpBody);
        if (body.isErr()) return body.error;
        return (await service.importMcp(body.value)).match(
            (server) => c.json(server satisfies McpServerView, 201),
            (e) => customizationError(c, e),
        );
    });

    // A page of the official MCP Registry. The server asks the registry, thus the GUI needs no network of its own.
    routes.get("/mcp/registry", async (c) =>
        (await service.searchRegistry(c.req.query("search") ?? "", c.req.query("cursor"))).match(
            (page) => c.json(page satisfies RegistryServerList),
            (e) => customizationError(c, e),
        ),
    );

    routes.post("/mcp/install", async (c) => {
        const body = await readBody(c, installMcpBody);
        if (body.isErr()) return body.error;
        return (await service.installMcp(body.value)).match(
            (server) => c.json(server satisfies McpServerView, 201),
            (e) => customizationError(c, e),
        );
    });

    routes.get("/mcp", async (c) =>
        (await service.listMcp()).match(
            (servers) => c.json({ servers } satisfies McpServerList),
            (e) => customizationError(c, e),
        ),
    );

    routes.post("/mcp", async (c) => {
        const body = await readBody(c, addMcpBody);
        if (body.isErr()) return body.error;
        return (await service.addMcp(body.value.name, body.value.entry)).match(
            (server) => c.json(server satisfies McpServerView, 201),
            (e) => customizationError(c, e),
        );
    });

    routes.patch("/mcp/:name", async (c) => {
        const body = await readBody(c, patchMcpBody);
        if (body.isErr()) return body.error;
        return (await service.setMcpEnabled(c.req.param("name"), body.value.enabled)).match(
            (server) => c.json(server satisfies McpServerView),
            (e) => customizationError(c, e),
        );
    });

    routes.delete("/mcp/:name", async (c) =>
        (await service.removeMcp(c.req.param("name"))).match(
            () => c.json({ deleted: true } satisfies DeleteMcpServerResponse),
            (e) => customizationError(c, e),
        ),
    );

    // The response waits for the person at the browser, for up to the timeout of the sign-in.
    routes.post("/mcp/:name/auth", async (c) => {
        holdConnection(c);
        return (await service.mcpAuth(c.req.param("name"))).match(
            () => c.json({ signedIn: true } satisfies McpAuthResponse),
            (e) => customizationError(c, e),
        );
    });

    routes.delete("/mcp/:name/auth", async (c) =>
        (await service.mcpLogout(c.req.param("name"))).match(
            (revocation) => c.json({ signedIn: false, revocation } satisfies McpLogoutResponse),
            (e) => customizationError(c, e),
        ),
    );

    return routes;
}
