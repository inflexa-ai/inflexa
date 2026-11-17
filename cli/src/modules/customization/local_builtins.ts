import { BUILTIN_AGENTS, type AgentAttachments, type BuiltinAgent, type BuiltinAgentId } from "@inflexa-ai/harness";

/**
 * What a local install attaches to a built-in agent beyond the defaults of the harness. A managed deployment does not
 * get these, because each one needs a capability of the CLI: the skill creator ends with the import of a custom skill.
 */
const LOCAL_ADDITIONS: Readonly<Partial<Record<BuiltinAgentId, Partial<AgentAttachments>>>> = {
    inflexa: { skills: ["skill-creator"] },
};

const KEYS = ["connectors", "mcp", "skills"] as const;

/** The built-in agents with the local additions in their defaults. The CLI reads this list in place of the harness list. */
export const LOCAL_BUILTIN_AGENTS: readonly BuiltinAgent[] = BUILTIN_AGENTS.map((agent) => {
    const additions = LOCAL_ADDITIONS[agent.id];
    if (additions === undefined) return agent;
    const merged = (key: (typeof KEYS)[number]): readonly string[] => [...new Set([...agent.defaults[key], ...(additions[key] ?? [])])];
    return { ...agent, defaults: { connectors: merged("connectors"), mcp: merged("mcp"), skills: merged("skills") } };
});

/** The ids of the built-in agents that have local additions. */
export const LOCALLY_EXTENDED_IDS: readonly BuiltinAgentId[] = BUILTIN_AGENTS.map((agent) => agent.id).filter((id) => LOCAL_ADDITIONS[id] !== undefined);

/**
 * The `add` of a built-in entry for the harness: the local additions that the user did not remove, then the additions
 * of the user. The harness merges `add` into its own defaults, thus a local addition reaches the agent through it.
 */
export function entryAdditions(id: BuiltinAgentId, add: Partial<AgentAttachments>, remove: Partial<AgentAttachments>): Partial<AgentAttachments> {
    const local = LOCAL_ADDITIONS[id];
    if (local === undefined) return add;
    const result: { -readonly [K in keyof AgentAttachments]?: readonly string[] } = { ...add };
    for (const key of KEYS) {
        const removed = new Set(remove[key] ?? []);
        const kept = (local[key] ?? []).filter((item) => !removed.has(item));
        if (kept.length > 0) result[key] = [...new Set([...kept, ...(add[key] ?? [])])];
    }
    return result;
}
