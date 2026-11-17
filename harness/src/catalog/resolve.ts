/**
 * The resolution of a catalog: the built-in agents merged with the entries of the host. A reference that does not
 * resolve becomes a gap that names the agent and the reference, and the agent resolves without it. A gap never stops
 * the boot, a plan, or a run.
 */

import { createHash } from "node:crypto";

import { CONNECTORS } from "../connectors/registry.js";
import { BUILTIN_AGENTS, BUILTIN_AGENT_IDS, type BuiltinAgent } from "./builtins.js";
import type { AgentAttachments, AgentCatalog, AgentEntry, AgentIdentity, AgentRole, ConnectorSettings, McpServerConfig, SingleAgentRole } from "./types.js";

export type ResolvedAgent = {
    readonly id: string;
    readonly name: string;
    readonly role: AgentRole;
    readonly description: string;
    /** The prompt body. The harness adds the parts that each agent of the role shares. */
    readonly prompt: string;
    readonly builtin: boolean;
    readonly attachments: AgentAttachments;
    readonly defaultMaxSteps?: number;
};

export type CatalogGapReason =
    | "unknown_connector"
    | "unknown_mcp_server"
    | "unknown_skill"
    | "duplicate_id"
    | "builtin_id"
    | "cannot_disable"
    | "scriptable_needs_no_approval"
    | "approval_needs_a_person"
    | "role_agent_unavailable";

export type CatalogGap = {
    readonly reason: CatalogGapReason;
    /** The agent, the MCP server, or the role that the gap belongs to. */
    readonly subject: string;
    /** The reference that did not resolve. */
    readonly reference?: string;
};

export type ResolvedCatalog = {
    /** Each enabled agent, by id. */
    readonly agents: ReadonlyMap<string, ResolvedAgent>;
    /** The active agent of each role that one agent fills, by id. A role whose agent is off has no entry. */
    readonly roles: ReadonlyMap<SingleAgentRole, string>;
    readonly gaps: readonly CatalogGap[];
    /** The settings of each enabled connector of the registry. */
    readonly connectors: ReadonlyMap<string, ConnectorSettings>;
    readonly mcpServers: ReadonlyMap<string, McpServerConfig>;
};

/** A built-in agent with the changes of its entry. An entry cannot turn off an agent that must stay on. */
function mergeBuiltin(agent: BuiltinAgent, entry: Extract<AgentEntry, { kind: "builtin" }> | undefined, gaps: CatalogGap[]): ResolvedAgent | undefined {
    if (entry !== undefined && !entry.enabled) {
        if (agent.canDisable) return undefined;
        gaps.push({ reason: "cannot_disable", subject: agent.id });
    }
    const merge = (key: keyof AgentAttachments): readonly string[] => {
        const removed = new Set(entry?.remove[key] ?? []);
        const kept = agent.defaults[key].filter((item) => !removed.has(item));
        return [...new Set([...kept, ...(entry?.add[key] ?? [])])];
    };
    return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        description: agent.description,
        prompt: agent.prompt,
        builtin: true,
        attachments: { connectors: merge("connectors"), mcp: merge("mcp"), skills: merge("skills") },
        defaultMaxSteps: agent.defaultMaxSteps,
    };
}

/**
 * The roles whose agent runs in a chat turn, where the user answers an approval. Each other role runs with no person
 * to answer: a run step, a sub-agent of a tool, or a task. There each call that asks for approval is refused.
 */
const ROLES_WITH_APPROVER: ReadonlySet<AgentRole> = new Set(["chat", "reporter"]);

/** True when a person can answer the approval of a call of an agent of `role`. */
export function canAnswerApproval(role: AgentRole): boolean {
    return ROLES_WITH_APPROVER.has(role);
}

function checkAttachments(
    agent: ResolvedAgent,
    known: { connectors: ReadonlySet<string>; mcp: ReadonlyMap<string, McpServerConfig>; skills: ReadonlySet<string> },
    gaps: CatalogGap[],
): ResolvedAgent {
    const keep = (items: readonly string[], set: { has: (item: string) => boolean }, reason: CatalogGapReason): string[] =>
        items.filter((item) => {
            if (set.has(item)) return true;
            gaps.push({ reason, subject: agent.id, reference: item });
            return false;
        });
    const answerable = canAnswerApproval(agent.role);
    const connectors = keep(agent.attachments.connectors, known.connectors, "unknown_connector");
    const mcp = keep(agent.attachments.mcp, known.mcp, "unknown_mcp_server").filter((name) => {
        if (answerable || known.mcp.get(name)?.approval !== "always") return true;
        gaps.push({ reason: "approval_needs_a_person", subject: agent.id, reference: name });
        return false;
    });
    const skills = keep(agent.attachments.skills, known.skills, "unknown_skill");
    return { ...agent, attachments: { connectors, mcp, skills } };
}

/** A connector that the host turned off is absent for each agent, without a gap. */
function withoutDisabledConnectors(agent: ResolvedAgent, disabled: ReadonlySet<string>): ResolvedAgent {
    if (disabled.size === 0) return agent;
    return { ...agent, attachments: { ...agent.attachments, connectors: agent.attachments.connectors.filter((id) => !disabled.has(id)) } };
}

export async function resolveCatalog(catalog: AgentCatalog): Promise<ResolvedCatalog> {
    const [entries, servers, settings, skills, assignments] = await Promise.all([
        catalog.agents(),
        catalog.mcpServers(),
        catalog.connectors(),
        catalog.skills.list(),
        catalog.roles(),
    ]);
    const gaps: CatalogGap[] = [];

    const mcpServers = new Map<string, McpServerConfig>();
    for (const server of servers) {
        if (server.scriptable && server.approval === "always") {
            gaps.push({ reason: "scriptable_needs_no_approval", subject: server.name });
            mcpServers.set(server.name, { ...server, scriptable: false });
        } else {
            mcpServers.set(server.name, server);
        }
    }

    const connectors = new Map<string, ConnectorSettings>();
    const disabledConnectors = new Set<string>();
    for (const id of CONNECTORS.keys()) connectors.set(id, { id, enabled: true });
    for (const setting of settings) {
        if (!CONNECTORS.has(setting.id)) {
            gaps.push({ reason: "unknown_connector", subject: setting.id });
            continue;
        }
        if (setting.enabled) connectors.set(setting.id, setting);
        else {
            connectors.delete(setting.id);
            disabledConnectors.add(setting.id);
        }
    }

    const builtinEntries = new Map<string, Extract<AgentEntry, { kind: "builtin" }>>();
    const customEntries: Extract<AgentEntry, { kind: "custom" }>[] = [];
    for (const entry of entries) {
        if (entry.kind === "builtin") builtinEntries.set(entry.id, entry);
        else customEntries.push(entry);
    }

    const resolved: ResolvedAgent[] = [];
    for (const agent of BUILTIN_AGENTS) {
        const merged = mergeBuiltin(agent, builtinEntries.get(agent.id), gaps);
        if (merged !== undefined) resolved.push(merged);
    }

    const customIds = new Map<string, number>();
    for (const { definition } of customEntries) customIds.set(definition.id, (customIds.get(definition.id) ?? 0) + 1);
    for (const { enabled, definition } of customEntries) {
        if (BUILTIN_AGENT_IDS.has(definition.id)) {
            gaps.push({ reason: "builtin_id", subject: definition.id });
            continue;
        }
        if ((customIds.get(definition.id) ?? 0) > 1) {
            gaps.push({ reason: "duplicate_id", subject: definition.id });
            continue;
        }
        if (!enabled) continue;
        resolved.push({
            id: definition.id,
            name: definition.name,
            role: definition.role,
            description: definition.description,
            prompt: definition.prompt,
            builtin: false,
            attachments: { connectors: definition.connectors, mcp: definition.mcp, skills: definition.skills },
        });
    }

    const known = {
        connectors: new Set([...connectors.keys(), ...disabledConnectors]),
        mcp: mcpServers,
        skills: new Set(skills.map((skill) => skill.name)),
    };
    const agents = new Map<string, ResolvedAgent>();
    for (const agent of resolved) agents.set(agent.id, withoutDisabledConnectors(checkAttachments(agent, known, gaps), disabledConnectors));
    return { agents, roles: activeRoles(agents, assignments, gaps), gaps, connectors, mcpServers };
}

export const SINGLE_AGENT_ROLES: readonly SingleAgentRole[] = ["chat", "planner", "profiler", "synthesizer", "analogy", "reporter"];

export const AGENT_ROLES: readonly AgentRole[] = ["chat", "planner", "executor", "profiler", "synthesizer", "analogy", "reporter"];

/**
 * The active agent of each role that one agent fills: the agent that the host chose, when it is on and has that role,
 * else the built-in agent of the role. A choice that does not resolve is a gap, and the role keeps its built-in agent.
 */
function activeRoles(
    agents: ReadonlyMap<string, ResolvedAgent>,
    assignments: Readonly<Partial<Record<SingleAgentRole, string>>>,
    gaps: CatalogGap[],
): Map<SingleAgentRole, string> {
    const roles = new Map<SingleAgentRole, string>();
    for (const role of SINGLE_AGENT_ROLES) {
        const chosen = assignments[role];
        if (chosen !== undefined) {
            if (agents.get(chosen)?.role === role) {
                roles.set(role, chosen);
                continue;
            }
            gaps.push({ reason: "role_agent_unavailable", subject: role, reference: chosen });
        }
        const builtin = BUILTIN_AGENTS.find((agent) => agent.role === role);
        if (builtin !== undefined && agents.has(builtin.id)) roles.set(role, builtin.id);
    }
    return roles;
}

/** The enabled executors, the built-in ones first. */
export function executorsOf(resolved: ResolvedCatalog): readonly ResolvedAgent[] {
    return [...resolved.agents.values()].filter((agent) => agent.role === "executor");
}

/** The built-in agent of a role with its release defaults, as the catalog resolves it when the host changes nothing. */
export function builtinOfRole(role: SingleAgentRole): ResolvedAgent {
    const agent = BUILTIN_AGENTS.find((candidate) => candidate.role === role);
    // BUILTIN_AGENTS holds one built-in agent for each role that one agent fills.
    if (agent === undefined) throw new Error(`no built-in agent for the role ${role}`);
    const { id, name, description, prompt, defaults, defaultMaxSteps } = agent;
    return { id, name, role, description, prompt, builtin: true, attachments: defaults, defaultMaxSteps };
}

/** The active agent of a role that one agent fills, or `undefined` when the role is off. */
export function agentOfRole(resolved: ResolvedCatalog, role: SingleAgentRole): ResolvedAgent | undefined {
    const id = resolved.roles.get(role);
    return id === undefined ? undefined : resolved.agents.get(id);
}

export function promptHash(prompt: string): string {
    return createHash("sha256").update(prompt).digest("hex");
}

export function agentIdentityOf(agent: ResolvedAgent): AgentIdentity {
    return { id: agent.id, name: agent.name, role: agent.role, prompt: agent.prompt, promptHash: promptHash(agent.prompt) };
}
