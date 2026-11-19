import { describe, expect, test } from "bun:test";

import type { AgentDetail, AgentList, AgentView, ConnectorView, SkillList, SkillView } from "../../api/customization.ts";
import { commands } from "../commands.tsx";
import { agentDetailLines, agentItems, connectorMenuItems, credentialItems, mcpLines, skillItems } from "../customize_commands.tsx";

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
    test("the custom agents come first, the newest first, then the built-in agents, and a draft says so", () => {
        const list: AgentList = {
            agents: [
                agent("analyst", { kind: "builtin" }),
                agent("old", { modifiedAt: "2026-11-01T10:00:00.000Z" }),
                agent("new", { modifiedAt: "2026-11-19T10:00:00.000Z" }),
                agent("broken", { draft: true }),
            ],
            roles: [],
        };

        const items = agentItems(list);

        expect(items.map((item) => item.value)).toEqual(["new", "old", "broken", "analyst"]);
        expect(items.find((item) => item.value === "broken")?.description).toContain("draft");
        expect(items.find((item) => item.value === "analyst")?.description).toStartWith("built-in");
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
    test("the custom skills come first, the newest first, then the built-in skills, then each folder that does not load", () => {
        const list: SkillList = {
            skills: [
                skill("single-cell", { kind: "builtin", title: "Single-Cell Analysis" }),
                skill("old", { modifiedAt: "2026-11-01T10:00:00.000Z" }),
                skill("new", { modifiedAt: "2026-11-19T10:00:00.000Z" }),
            ],
            problems: [{ directory: "/skills/broken", kind: "custom", message: "The SKILL.md does not open with YAML frontmatter." }],
        };

        const items = skillItems(list);

        expect(items.map((item) => item.title)).toEqual(["new", "old", "single-cell", "/skills/broken"]);
        expect(items[3]?.value).toEqual({ kind: "problem", directory: "/skills/broken", message: "The SKILL.md does not open with YAML frontmatter." });
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
