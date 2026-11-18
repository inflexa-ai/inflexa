/**
 * What one agent gets from the catalog when it is built for a turn or a step: the tools of its connectors, the index
 * of its skills, and the tools of its MCP servers.
 */

import { buildConnectorTools, type ConnectorBase } from "../connectors/build.js";
import { KNOWLEDGE_CONNECTOR_ID } from "../connectors/registry.js";
import type { Tool } from "../tools/define-tool.js";
import { skillIndex } from "../tools/sandbox/skills.js";
import { agentOfRole, builtinOfRole, resolveCatalog, type ResolvedAgent, type ResolvedCatalog } from "./resolve.js";
import type { AgentAttachments, AgentCatalog, SingleAgentRole, SkillStore } from "./types.js";

/** The MCP tools of an agent: each is a direct tool, and the tools of a scriptable server are also script tools. */
export type McpAgentTools = {
    readonly direct: readonly Tool[];
    readonly script: readonly Tool[];
    /** The attached servers that did not start, with the reason. Their tools are absent. */
    readonly unavailable: readonly McpServerFailure[];
};

/** An MCP server that did not start or did not list its tools. */
export type McpServerFailure = {
    readonly server: string;
    readonly at: Date;
    readonly reason: string;
};

/**
 * The part of a system prompt that names each attached MCP server that did not start, or `undefined` when each one
 * started. Without it, an agent that misses the tools of a server guesses a reason.
 */
export function mcpFailureNotice(unavailable: readonly McpServerFailure[]): string | undefined {
    if (unavailable.length === 0) return undefined;
    return [
        "## MCP Servers That Did Not Start",
        "",
        "These attached MCP servers did not start for this turn, thus their tools are absent:",
        "",
        ...unavailable.map((failure) => `- \`${failure.server}\`: ${failure.reason}`),
    ].join("\n");
}

/** The MCP side of the catalog services. The harness connects to each server at its first use. */
export type McpToolSource = {
    readonly toolsFor: (servers: readonly string[], resolved: ResolvedCatalog) => Promise<McpAgentTools>;
};

/** What the harness needs to build an agent from the catalog. The assembly makes it one time. */
export type CatalogServices = {
    readonly catalog: AgentCatalog;
    readonly connectorBase: ConnectorBase;
    readonly mcp?: McpToolSource;
};

export type AgentEquipment = {
    readonly connectorIds: readonly string[];
    readonly connectorTools: readonly Tool[];
    readonly skills: readonly string[];
    readonly skillIndex: string | undefined;
    readonly skillStore: SkillStore;
    readonly mcp: McpAgentTools;
};

const NO_MCP_TOOLS: McpAgentTools = { direct: [], script: [], unavailable: [] };

/** The equipment of the attachments of one agent. */
export async function equipAttachments(services: CatalogServices, resolved: ResolvedCatalog, attachments: AgentAttachments): Promise<AgentEquipment> {
    const [connectorTools, listed, mcp] = await Promise.all([
        buildConnectorTools(services.catalog, resolved, attachments.connectors, services.connectorBase),
        services.catalog.skills.list(),
        attachments.mcp.length === 0 || services.mcp === undefined ? Promise.resolve(NO_MCP_TOOLS) : services.mcp.toolsFor(attachments.mcp, resolved),
    ]);
    return {
        connectorIds: attachments.connectors,
        connectorTools,
        skills: attachments.skills,
        skillIndex: skillIndex(listed, attachments.skills),
        skillStore: services.catalog.skills,
        mcp,
    };
}

export function equipAgent(services: CatalogServices, resolved: ResolvedCatalog, agent: ResolvedAgent): Promise<AgentEquipment> {
    return equipAttachments(services, resolved, agent.attachments);
}

/** The active agent of a role, with its prompt body and its equipment. */
export type RoleSetup = {
    readonly agent: ResolvedAgent;
    readonly equipment: AgentEquipment;
};

/** The setup of the active agent of `role` in a resolved catalog, or `undefined` when the role is off. */
export async function roleSetupIn(services: CatalogServices, resolved: ResolvedCatalog, role: SingleAgentRole): Promise<RoleSetup | undefined> {
    const agent = agentOfRole(resolved, role);
    return agent === undefined ? undefined : { agent, equipment: await equipAgent(services, resolved, agent) };
}

/**
 * The setup of the active agent of a role that cannot be off. The built-in agent of the role is the fallback of a
 * catalog that holds no agent of the role, for example an empty catalog of a test.
 */
export async function requiredRoleSetup(services: CatalogServices, resolved: ResolvedCatalog, role: SingleAgentRole): Promise<RoleSetup> {
    const agent = agentOfRole(resolved, role) ?? builtinOfRole(role);
    return { agent, equipment: await equipAgent(services, resolved, agent) };
}

/** The setup of the active agent of `role` from the catalog now, or `undefined` when the role is off. */
export async function roleSetupOf(services: CatalogServices, role: SingleAgentRole): Promise<RoleSetup | undefined> {
    return roleSetupIn(services, await resolveCatalog(services.catalog), role);
}

/** The knowledge connector is a gate: each agent builds the tools of the knowledge plane itself. */
export function attachesKnowledge(equipment: Pick<AgentEquipment, "connectorIds">): boolean {
    return equipment.connectorIds.includes(KNOWLEDGE_CONNECTOR_ID);
}
