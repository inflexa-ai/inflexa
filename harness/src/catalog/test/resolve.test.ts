import { describe, expect, it } from "bun:test";

import { BUILTIN_AGENTS, builtinAgent } from "../builtins.js";
import { createInMemoryCatalog, createInMemorySkillStore } from "../memory.js";
import { agentIdentityOf, agentOfRole, executorsOf, resolveCatalog } from "../resolve.js";
import type { AgentEntry, CustomAgent } from "../types.js";

const skills = createInMemorySkillStore(
    [...new Set(BUILTIN_AGENTS.flatMap((agent) => agent.defaults.skills)), "lab-protocols"].map((name) => ({ name, description: `The ${name} skill.` })),
);

const custom = (overrides: Partial<CustomAgent> = {}): CustomAgent => ({
    id: "lipid-analyst",
    name: "Lipid analyst",
    role: "executor",
    description: "Lipidomics.",
    prompt: "You analyze lipids.",
    connectors: ["pubmed"],
    mcp: [],
    skills: [],
    ...overrides,
});

const builtinEntry = (entry: Partial<Extract<AgentEntry, { kind: "builtin" }>> & Pick<Extract<AgentEntry, { kind: "builtin" }>, "id">): AgentEntry => ({
    kind: "builtin",
    enabled: true,
    add: {},
    remove: {},
    ...entry,
});

describe("resolveCatalog", () => {
    it("lists each built-in agent with its role", async () => {
        const resolved = await resolveCatalog(createInMemoryCatalog({ skills }));
        expect(Object.fromEntries([...resolved.agents.values()].map((agent) => [agent.id, agent.role]))).toEqual({
            inflexa: "chat",
            planner: "planner",
            analyst: "executor",
            "drug-analyst": "executor",
            "data-profiler": "profiler",
            synthesizer: "synthesizer",
            analogy: "analogy",
            reporter: "reporter",
        });
        expect(resolved.gaps).toEqual([]);
    });

    it("keeps the release defaults of a built-in agent with no entry", async () => {
        const resolved = await resolveCatalog(createInMemoryCatalog({ skills }));
        expect(resolved.agents.get("drug-analyst")?.attachments).toEqual(builtinAgent("drug-analyst").defaults);
    });

    it("applies add and remove over the release defaults", async () => {
        const resolved = await resolveCatalog(
            createInMemoryCatalog({
                skills,
                mcpServers: [
                    { name: "lab-lims", transport: { kind: "http", url: "http://127.0.0.1:1/mcp", headers: {} }, approval: "never", scriptable: false },
                ],
                agents: [builtinEntry({ id: "analyst", add: { mcp: ["lab-lims"], skills: ["lab-protocols"] }, remove: { connectors: ["pubmed"] } })],
            }),
        );
        const analyst = resolved.agents.get("analyst");
        expect(analyst?.attachments.mcp).toEqual(["lab-lims"]);
        expect(analyst?.attachments.skills).toContain("lab-protocols");
        expect(analyst?.attachments.connectors).not.toContain("pubmed");
        expect(analyst?.attachments.connectors).toContain("gnomad");
    });

    it("lets the user change the attachments of the planner", async () => {
        const resolved = await resolveCatalog(createInMemoryCatalog({ skills, agents: [builtinEntry({ id: "planner", add: { skills: ["lab-protocols"] } })] }));
        expect(agentOfRole(resolved, "planner")?.attachments.skills).toEqual(["lab-protocols"]);
    });

    it("keeps the analyst and the planner on, and names the entry in a gap", async () => {
        const resolved = await resolveCatalog(
            createInMemoryCatalog({ skills, agents: [builtinEntry({ id: "analyst", enabled: false }), builtinEntry({ id: "planner", enabled: false })] }),
        );
        expect(resolved.agents.has("analyst")).toBe(true);
        expect(resolved.agents.has("planner")).toBe(true);
        expect(resolved.gaps).toEqual([
            { reason: "cannot_disable", subject: "planner" },
            { reason: "cannot_disable", subject: "analyst" },
        ]);
    });

    it("turns off the drug analyst and the analogy agent", async () => {
        const resolved = await resolveCatalog(
            createInMemoryCatalog({ skills, agents: [builtinEntry({ id: "drug-analyst", enabled: false }), builtinEntry({ id: "analogy", enabled: false })] }),
        );
        expect(executorsOf(resolved).map((agent) => agent.id)).toEqual(["analyst"]);
        expect(agentOfRole(resolved, "analogy")).toBeUndefined();
        expect(resolved.gaps).toEqual([]);
    });

    it("adds an enabled custom executor and leaves out a disabled one", async () => {
        const resolved = await resolveCatalog(
            createInMemoryCatalog({
                skills,
                agents: [
                    { kind: "custom", enabled: true, definition: custom() },
                    { kind: "custom", enabled: false, definition: custom({ id: "off-analyst" }) },
                ],
            }),
        );
        expect(executorsOf(resolved).map((agent) => agent.id)).toEqual(["analyst", "drug-analyst", "lipid-analyst"]);
    });

    it("turns an unknown reference into a gap and keeps the agent", async () => {
        const resolved = await resolveCatalog(
            createInMemoryCatalog({
                skills,
                agents: [{ kind: "custom", enabled: true, definition: custom({ skills: ["lipidomics"], mcp: ["lipidmaps"], connectors: ["pubmed", "nope"] }) }],
            }),
        );
        expect(resolved.agents.get("lipid-analyst")?.attachments).toEqual({ connectors: ["pubmed"], mcp: [], skills: [] });
        expect(resolved.gaps).toEqual([
            { reason: "unknown_connector", subject: "lipid-analyst", reference: "nope" },
            { reason: "unknown_mcp_server", subject: "lipid-analyst", reference: "lipidmaps" },
            { reason: "unknown_skill", subject: "lipid-analyst", reference: "lipidomics" },
        ]);
    });

    it("refuses a custom agent with a built-in id, a duplicate id, or another role", async () => {
        const resolved = await resolveCatalog(
            createInMemoryCatalog({
                skills,
                agents: [
                    { kind: "custom", enabled: true, definition: custom({ id: "analyst" }) },
                    { kind: "custom", enabled: true, definition: custom({ id: "twin" }) },
                    { kind: "custom", enabled: true, definition: custom({ id: "twin" }) },
                    { kind: "custom", enabled: true, definition: custom({ id: "chatty", role: "chat" }) },
                ],
            }),
        );
        expect(resolved.agents.get("analyst")?.builtin).toBe(true);
        expect(resolved.agents.has("twin")).toBe(false);
        expect(resolved.agents.has("chatty")).toBe(false);
        expect(resolved.gaps).toEqual([
            { reason: "builtin_id", subject: "analyst" },
            { reason: "duplicate_id", subject: "twin" },
            { reason: "duplicate_id", subject: "twin" },
            { reason: "role_not_allowed", subject: "chatty", reference: "chat" },
        ]);
    });

    it("removes a disabled connector from each agent with no gap", async () => {
        const resolved = await resolveCatalog(createInMemoryCatalog({ skills, connectors: [{ id: "pubmed", enabled: false }] }));
        for (const agent of resolved.agents.values()) expect(agent.attachments.connectors).not.toContain("pubmed");
        expect(resolved.connectors.has("pubmed")).toBe(false);
        expect(resolved.gaps).toEqual([]);
    });

    it("refuses a scriptable server that needs approval", async () => {
        const resolved = await resolveCatalog(
            createInMemoryCatalog({
                skills,
                mcpServers: [{ name: "lims", transport: { kind: "stdio", command: "lims", args: [], env: {} }, approval: "always", scriptable: true }],
            }),
        );
        expect(resolved.mcpServers.get("lims")?.scriptable).toBe(false);
        expect(resolved.gaps).toEqual([{ reason: "scriptable_needs_no_approval", subject: "lims" }]);
    });

    it("keeps a server that needs approval on the chat agent, and leaves it out of an agent that no person answers", async () => {
        const lims = { name: "lims", transport: { kind: "stdio", command: "lims", args: [], env: {} }, approval: "always", scriptable: false } as const;
        const add = { connectors: [], mcp: ["lims"], skills: [] };
        const remove = { connectors: [], mcp: [], skills: [] };
        const resolved = await resolveCatalog(
            createInMemoryCatalog({
                skills,
                mcpServers: [lims],
                agents: [
                    { kind: "builtin", id: "inflexa", enabled: true, add, remove },
                    { kind: "builtin", id: "planner", enabled: true, add, remove },
                    { kind: "custom", enabled: true, definition: custom({ mcp: ["lims"] }) },
                ],
            }),
        );
        expect(resolved.agents.get("inflexa")?.attachments.mcp).toEqual(["lims"]);
        expect(resolved.agents.get("planner")?.attachments.mcp).toEqual([]);
        expect(resolved.agents.get(custom().id)?.attachments.mcp).toEqual([]);
        expect(resolved.gaps).toEqual([
            { reason: "approval_needs_a_person", subject: "planner", reference: "lims" },
            { reason: "approval_needs_a_person", subject: custom().id, reference: "lims" },
        ]);
    });

    it("gives one prompt hash for one prompt and a new hash for an edit", async () => {
        const first = await resolveCatalog(createInMemoryCatalog({ skills, agents: [{ kind: "custom", enabled: true, definition: custom() }] }));
        const again = await resolveCatalog(createInMemoryCatalog({ skills, agents: [{ kind: "custom", enabled: true, definition: custom() }] }));
        const edited = await resolveCatalog(
            createInMemoryCatalog({ skills, agents: [{ kind: "custom", enabled: true, definition: custom({ prompt: "You analyze sterols." }) }] }),
        );
        const hashOf = (resolved: typeof first) => {
            const agent = resolved.agents.get("lipid-analyst");
            if (agent === undefined) throw new Error("no lipid-analyst");
            return agentIdentityOf(agent).promptHash;
        };
        expect(hashOf(first)).toBe(hashOf(again));
        expect(hashOf(edited)).not.toBe(hashOf(first));
    });
});
