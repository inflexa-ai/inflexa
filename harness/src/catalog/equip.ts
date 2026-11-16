/**
 * What one agent gets from the catalog when it is built for a turn or a step: the tools of its connectors, the index
 * of its skills, and the tools of its MCP servers.
 */

import { buildConnectorTools, type ConnectorBase } from "../connectors/build.js";
import { KNOWLEDGE_CONNECTOR_ID } from "../connectors/registry.js";
import type { Tool } from "../tools/define-tool.js";
import { skillIndex } from "../tools/sandbox/skills.js";
import type { ResolvedAgent, ResolvedCatalog } from "./resolve.js";
import type { AgentAttachments, AgentCatalog, SkillStore } from "./types.js";

/** The MCP tools of an agent: each is a direct tool, and the tools of a scriptable server are also script tools. */
export type McpAgentTools = {
    readonly direct: readonly Tool[];
    readonly script: readonly Tool[];
};

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

const NO_MCP_TOOLS: McpAgentTools = { direct: [], script: [] };

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

/** The knowledge connector is a gate: each agent builds the tools of the knowledge plane itself. */
export function attachesKnowledge(equipment: Pick<AgentEquipment, "connectorIds">): boolean {
    return equipment.connectorIds.includes(KNOWLEDGE_CONNECTOR_ID);
}
