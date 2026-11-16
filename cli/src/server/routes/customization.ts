import { Hono, type Context } from "hono";
import { z } from "zod";

import {
    ATTACHMENT_KINDS,
    type AgentDetail,
    type AgentList,
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
import { credentialSourceSchema, mcpServerEntrySchema } from "../../lib/config.ts";
import { customizationErrorMessage, type CustomizationError, type CustomizationService } from "../../modules/customization/service.ts";
import { apiError, holdConnection, internalError, readBody, type ServerEnv } from "../http.ts";

const attachmentChangeSchema = z.object({ kind: z.enum(ATTACHMENT_KINDS), name: z.string().min(1) });

/** The body of `PATCH /agents/:id`. `prompt` is read only to refuse it with a reason. */
const patchAgentBody = z.object({
    enabled: z.boolean().optional(),
    attach: attachmentChangeSchema.optional(),
    detach: attachmentChangeSchema.optional(),
    prompt: z.string().optional(),
});

const cloneAgentBody = z.object({ newId: z.string() });
const importBody = z.object({ path: z.string().min(1) });
const patchConnectorBody = z.object({
    enabled: z.boolean().optional(),
    endpoint: z.string().nullable().optional(),
    credentials: z.record(z.string(), z.string().nullable()).optional(),
});
const addMcpBody = z.object({ name: z.string(), entry: mcpServerEntrySchema });
const patchMcpBody = z.object({ enabled: z.boolean() });

/** The code of each {@link CustomizationError} that a client can act on. `null` marks a failure of the server itself. */
function codeOf(e: CustomizationError): ApiErrorCode | null {
    switch (e.type) {
        case "unknown_agent":
        case "unknown_connector":
        case "unknown_mcp_server":
        case "skill_dir_missing":
            return "not_found";
        case "agent_exists":
        case "skill_exists":
        case "mcp_server_exists":
            return "conflict";
        case "cannot_disable":
        case "builtin_agent":
            return "forbidden";
        case "invalid_agent_id":
        case "not_an_executor":
        case "draft_unreadable":
        case "unknown_reference":
        case "approval_needs_a_person":
        case "import_failed":
        case "invalid_skill":
        case "unknown_slot":
        case "invalid_credential_name":
        case "invalid_mcp_name":
        case "invalid_mcp_entry":
        case "mcp_server_invalid":
        case "not_oauth":
            return "validation_error";
        case "sign_in_failed":
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

    routes.get("/agents", async (c) =>
        (await service.listAgents()).match(
            (agents) => c.json({ agents } satisfies AgentList),
            (e) => customizationError(c, e),
        ),
    );

    routes.post("/agents/import", async (c) => {
        const body = await readBody(c, importBody);
        if (body.isErr()) return body.error;
        return (await service.importAgent(body.value.path)).match(
            (agent) => c.json(agent satisfies AgentDetail, 201),
            (e) => customizationError(c, e),
        );
    });

    routes.get("/agents/:id", async (c) =>
        (await service.showAgent(c.req.param("id"))).match(
            (agent) => c.json(agent satisfies AgentDetail),
            (e) => customizationError(c, e),
        ),
    );

    routes.post("/agents/:id/clone", async (c) => {
        const body = await readBody(c, cloneAgentBody);
        if (body.isErr()) return body.error;
        return (await service.cloneAgent(c.req.param("id"), body.value.newId)).match(
            (agent) => c.json(agent satisfies AgentDetail, 201),
            (e) => customizationError(c, e),
        );
    });

    // The fields apply in a fixed order: `enabled`, then `attach`, then `detach`. A body with no field reads the agent.
    routes.patch("/agents/:id", async (c) => {
        const id = c.req.param("id");
        const body = await readBody(c, patchAgentBody);
        if (body.isErr()) return body.error;
        const { enabled, attach, detach, prompt } = body.value;
        if (prompt !== undefined) {
            const current = await service.showAgent(id);
            if (current.isErr()) return customizationError(c, current.error);
            return current.value.kind === "builtin"
                ? apiError(
                      c,
                      "forbidden",
                      `The prompt of the built-in agent "${id}" is read-only. \`inflexa agent clone ${id} <new-id>\` makes a copy whose prompt you can edit.`,
                  )
                : apiError(c, "validation_error", `Edit the prompt of "${id}" in its file: ${current.value.path ?? "the agents directory"}.`);
        }
        let result = enabled === undefined ? service.showAgent(id) : service.setAgentEnabled(id, enabled);
        if (attach !== undefined) result = result.andThen(() => service.attach(id, attach.kind, attach.name));
        if (detach !== undefined) result = result.andThen(() => service.detach(id, detach.kind, detach.name));
        return (await result).match(
            (agent) => c.json(agent satisfies AgentDetail),
            (e) => customizationError(c, e),
        );
    });

    routes.delete("/agents/:id", async (c) =>
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

    routes.post("/skills/import", async (c) => {
        const body = await readBody(c, importBody);
        if (body.isErr()) return body.error;
        return (await service.importSkill(body.value.path)).match(
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
        const body = await readBody(c, credentialSourceSchema);
        if (body.isErr()) return body.error;
        return (await service.setCredential(c.req.param("name"), body.value)).match(
            (credential) => c.json(credential satisfies CredentialView),
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
