import { describe, expect, test } from "bun:test";

import type { AgentDetail, AgentList, AgentView, ConnectorView, SkillList, SkillView } from "../../api/customization.ts";
import { commands } from "../commands.tsx";
import { agentDetailLines, agentItems, connectorMenuItems, credentialItems, mcpLines, skillItems, usedByText } from "../customize_commands.tsx";

function agent(id: string, overrides: Partial<AgentView> = {}): AgentView {
    return {
        id,
        name: id,
        kind: "custom",
        draft: false,
        role: "executor",
        description: `The ${id} agent.`,
        enabled: true,
        canDisable: true,
        active: true,
        attachments: { connectors: [], mcp: [], skills: [] },
        gaps: [],
        ...overrides,
    };
}

function skill(name: string, overrides: Partial<SkillView> = {}): SkillView {
    return { name, description: `Read before you use ${name}.`, kind: "custom", directory: `/skills/${name}`, tags: [], ...overrides };
}

describe("the Customize group", () => {
    test("the palette holds each Customize command in one group", () => {
        const ids = commands.filter((command) => command.category === "Customize").map((command) => command.id);

        expect(ids).toEqual(["customize.agents", "customize.skills", "customize.mcp", "customize.connectors", "customize.credentials"]);
    });
});

describe("agentItems", () => {
    const list: AgentList = {
        agents: [
            agent("inflexa", { kind: "builtin", role: "chat" }),
            agent("inflexa-sketch", { role: "chat", active: false, modifiedAt: "2026-11-19T10:00:00.000Z" }),
            agent("analyst", { kind: "builtin" }),
            agent("drug-analyst", { kind: "builtin", enabled: false, active: false }),
            agent("old", { modifiedAt: "2026-11-01T10:00:00.000Z", active: false, enabled: false }),
            agent("new", { modifiedAt: "2026-11-19T10:00:00.000Z", attachments: { connectors: ["pubmed"], mcp: [], skills: ["a", "b"] } }),
            agent("broken", { draft: true, active: false, gaps: [{ reason: "invalid_yaml", message: "The frontmatter does not parse." }] }),
        ],
        roles: [],
    };

    test("the agents sit under one header for each role, the active agents first, then the custom agents, the newest first", () => {
        const items = agentItems(list);

        expect(items.map((item) => `${item.categoryLabel ?? ""}/${item.value}`)).toEqual([
            "Chat/inflexa",
            "Chat/inflexa-sketch",
            "Executors/new",
            "Executors/analyst",
            "Executors/old",
            "Executors/broken",
            "Executors/drug-analyst",
        ]);
    });

    test("a mark and a hint give the state of each agent, and a draft is a warning", () => {
        const byId = new Map(agentItems(list).map((item) => [item.value, item]));

        expect(byId.get("inflexa")).toMatchObject({ prefix: "●", hint: "active" });
        expect(byId.get("inflexa-sketch")).toMatchObject({ prefix: "○", hint: "not chosen · custom" });
        expect(byId.get("drug-analyst")).toMatchObject({ prefix: "○", hint: "off" });
        expect(byId.get("broken")).toMatchObject({ prefix: "!", hint: "draft · custom · 1 gap", tone: "warning" });
        expect(byId.get("new")?.description).toContain("2 skills, 1 connector, 0 MCP servers");
    });
});

describe("agentDetailLines", () => {
    test("the view gives the attachments, each gap, and the prompt", () => {
        const detail: AgentDetail = {
            ...agent("lipid-analyst", {
                attachments: { connectors: ["pubmed"], mcp: [], skills: ["lipidomics"] },
                gaps: [{ reason: "unknown_skill", reference: "x", message: 'No skill "x".' }],
            }),
            prompt: "Line one.\nLine two.",
        };

        const lines = agentDetailLines(detail);

        expect(lines).toContain("  connectors: pubmed");
        expect(lines).toContain("  MCP servers: none");
        expect(lines).toContain('  - No skill "x".');
        expect(lines.slice(-2)).toEqual(["Line one.", "Line two."]);
    });
});

describe("skillItems", () => {
    const list: SkillList = {
        skills: [
            skill("single-cell", { kind: "builtin", title: "Single-Cell Analysis" }),
            skill("old", { modifiedAt: "2026-11-01T10:00:00.000Z" }),
            skill("new", { modifiedAt: "2026-11-19T10:00:00.000Z" }),
        ],
        problems: [{ directory: "/skills/broken", kind: "custom", message: "The SKILL.md does not open with YAML frontmatter." }],
    };
    const agents: AgentList = {
        agents: [
            agent("inflexa", { kind: "builtin", role: "chat", attachments: { connectors: [], mcp: [], skills: ["new", "single-cell"] } }),
            agent("analyst", { kind: "builtin", attachments: { connectors: [], mcp: [], skills: ["single-cell"] } }),
            agent("drug-analyst", { kind: "builtin", enabled: false, active: false, attachments: { connectors: [], mcp: [], skills: ["old"] } }),
        ],
        roles: [],
    };

    test("the skills sit under Custom, Built-in and Not loaded, the newest custom skill first", () => {
        const items = skillItems(list, agents);

        expect(items.map((item) => `${item.categoryLabel ?? ""}/${item.title}`)).toEqual(["Custom/new", "Custom/old", "Built-in/single-cell", "Not loaded//skills/broken"]);
        expect(items[3]?.value).toEqual({ kind: "problem", directory: "/skills/broken", message: "The SKILL.md does not open with YAML frontmatter." });
    });

    test("a mark and a hint name the active agents that use each skill, and an agent that is off uses none", () => {
        const byTitle = new Map(skillItems(list, agents).map((item) => [item.title, item]));

        expect(byTitle.get("new")).toMatchObject({ prefix: "●", hint: "used by inflexa" });
        expect(byTitle.get("single-cell")).toMatchObject({ prefix: "●", hint: "used by inflexa, analyst" });
        expect(byTitle.get("old")).toMatchObject({ prefix: "○", hint: "not attached" });
    });

    test("with no agents, the rows give no mark and no use", () => {
        expect(skillItems(list, undefined)[0]).not.toHaveProperty("hint");
    });

    test("the hint counts the agents past two", () => {
        expect(usedByText(["a", "b", "c", "d"])).toBe("used by a, b +2");
    });
});

describe("connectorMenuItems", () => {
    test("the menu gives the endpoint with its default, then each slot with its credential and its state", () => {
        const connector: ConnectorView = {
            id: "pubmed",
            category: "literature",
            description: "PubMed.",
            defaultEndpoint: "https://eutils.example",
            slots: [{ slot: "api_key", required: false, credential: "ncbi-key", resolves: false }],
        };

        const items = connectorMenuItems(connector);

        expect(items.map((item) => item.title)).toEqual(["Endpoint", "Credential: api_key"]);
        expect(items[0]?.description).toBe("https://eutils.example (default)");
        expect(items[1]?.description).toContain("ncbi-key");
        expect(items[1]?.description).toContain("no value");
    });
});

describe("credentialItems", () => {
    test("each credential gives its source and never a value, and the last row adds a credential", () => {
        const items = credentialItems([
            { name: "ncbi-key", source: { kind: "env", var: "NCBI_API_KEY" }, resolves: true },
            { name: "lims-token", source: { kind: "stored" }, resolves: true },
            { name: "bad", problem: "kind: Invalid input" },
        ]);

        expect(items.map((item) => item.description)).toEqual([
            "env NCBI_API_KEY · gives a value",
            "stored value · gives a value",
            "not correct · kind: Invalid input",
            undefined,
        ]);
        expect(items.at(-1)?.value).toEqual({ kind: "add" });
    });
});

describe("mcpLines", () => {
    test("each server gives its command or its URL, its state, and the last failed start", () => {
        const lines = mcpLines([
            {
                name: "lims",
                entry: { type: "stdio", command: "lims-mcp", args: ["--ro"], env: {}, approval: "never", scriptable: false, enabled: true },
                startFailure: { at: "2026-11-18T10:00:00.000Z", reason: "Connection closed" },
            },
            { name: "broken", problem: "url: Invalid URL" },
        ]);

        expect(lines[0]).toBe("lims  (stdio, on, approval never)");
        expect(lines[1]).toBe("  lims-mcp --ro");
        expect(lines[2]).toContain("Connection closed");
        expect(lines).toContain("  url: Invalid URL");
    });
});
