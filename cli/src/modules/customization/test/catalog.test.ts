import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executorsOf, resolveCatalog, type McpOAuthProvider } from "@inflexa-ai/harness";

import type { Config } from "../../../lib/config.ts";
import { DEFAULT_THEME_ID } from "../../../lib/design_system.ts";
import { createFileCatalog, isValidMcpServerName, type FileCatalog } from "../catalog.ts";
import type { CredentialReader } from "../credentials.ts";
import { createMcpOAuthProvider, createMcpTokenStore } from "../mcp_tokens.ts";

let root = "";
let builtinSkillsDir = "";
let userSkillsDir = "";
let agentsDir = "";

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "inflexa-file-catalog-"));
    builtinSkillsDir = join(root, "builtin-skills");
    userSkillsDir = join(root, "user-skills");
    agentsDir = join(root, "agents");
    mkdirSync(agentsDir, { recursive: true });
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** The config of a new install with the given customization blocks. */
function config(blocks: Partial<Config> = {}): Config {
    return { telemetry: false, theme: DEFAULT_THEME_ID, leaderTimeout: 2000, embedding: { mode: "off" }, ...blocks };
}

function writeSkill(skillsRoot: string, name: string, description: string): void {
    mkdirSync(join(skillsRoot, name), { recursive: true });
    writeFileSync(join(skillsRoot, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nThe body.\n`);
}

function writeAgent(id: string, frontmatter: readonly string[], prompt = "Analyze the lipids."): void {
    writeFileSync(join(agentsDir, `${id}.md`), `---\nname: ${id}\n${frontmatter.join("\n")}\n---\n\n${prompt}\n`);
}

const credentials: CredentialReader = { read: (name) => Promise.resolve(name === "github" ? "gh-token" : undefined) };

function catalogOver(current: () => Config, mcpAuth?: (server: string, url: string) => McpOAuthProvider): FileCatalog {
    return createFileCatalog({ builtinSkillsDir, userSkillsDir, agentsDir, credentials, mcpAuth, readConfig: current });
}

describe("createFileCatalog — agents", () => {
    test("a change of a built-in agent becomes a builtin entry, and a key that is no built-in id is left out", async () => {
        const catalog = catalogOver(() =>
            config({
                agents: {
                    analyst: { add: { skills: ["lab-protocols"] }, remove: { connectors: ["chembl"] } },
                    planner: { enabled: false },
                    nobody: { enabled: false },
                },
            }),
        );

        expect(await catalog.agents()).toEqual([
            { kind: "builtin", id: "analyst", enabled: true, add: { skills: ["lab-protocols"] }, remove: { connectors: ["chembl"] } },
            { kind: "builtin", id: "planner", enabled: false, add: {}, remove: {} },
        ]);
    });

    test("a valid agent file becomes a custom entry, and a draft is left out", async () => {
        writeAgent("lipid-analyst", ["description: Analyzes lipid panels.", "connectors: [pubmed]"]);
        writeAgent("lims-analyst", ["description: d", "mcpServers: [lipidmaps]"]);
        const catalog = catalogOver(() => config());

        expect(await catalog.agents()).toEqual([
            {
                kind: "custom",
                enabled: true,
                definition: {
                    id: "lipid-analyst",
                    name: "lipid-analyst",
                    role: "executor",
                    description: "Analyzes lipid panels.",
                    prompt: "Analyze the lipids.",
                    connectors: ["pubmed"],
                    mcp: [],
                    skills: [],
                },
            },
        ]);
        expect((await catalog.agentFiles()).find((file) => file.id === "lims-analyst")).toMatchObject({
            status: "draft",
            gaps: [{ type: "unknown_mcp_server", name: "lipidmaps" }],
        });
    });

    test("`agents.<custom>.enabled: false` turns a custom agent off", async () => {
        writeAgent("lipid-analyst", ["description: d"]);
        const catalog = catalogOver(() => config({ agents: { "lipid-analyst": { enabled: false } } }));

        expect(await catalog.agents()).toMatchObject([{ kind: "custom", enabled: false, definition: { id: "lipid-analyst" } }]);
    });

    test("an agent file added after a first resolve is an executor of the next resolve, which the planner lists", async () => {
        const catalog = catalogOver(() => config());
        const before = executorsOf(await resolveCatalog(catalog)).map((agent) => agent.id);
        expect(before).not.toContain("lipid-analyst");

        writeAgent("lipid-analyst", ["description: Analyzes lipidomics data."]);

        const after = executorsOf(await resolveCatalog(catalog)).map((agent) => agent.id);
        expect(after).toEqual([...before, "lipid-analyst"]);
    });

    test("an edit of an agent file applies at the next read", async () => {
        writeAgent("lipid-analyst", ["description: d"], "The first prompt.");
        const catalog = catalogOver(() => config());
        expect(await catalog.agents()).toMatchObject([{ definition: { prompt: "The first prompt." } }]);

        writeAgent("lipid-analyst", ["description: d"], "The second prompt.");

        expect(await catalog.agents()).toMatchObject([{ definition: { prompt: "The second prompt." } }]);
    });

    test("an agent file resolves a server, a skill, and a connector that the catalog knows", async () => {
        writeSkill(userSkillsDir, "lab-protocols", "Protocols of the lab.");
        writeAgent("lims-analyst", ["description: d", "connectors: [pubmed]", "mcpServers: [lims]", "skills: [lab-protocols]"]);
        const catalog = catalogOver(() => config({ mcp: { lims: { type: "stdio", command: "lims-mcp" } } }));

        expect(await catalog.agents()).toMatchObject([{ kind: "custom", definition: { id: "lims-analyst", mcp: ["lims"], skills: ["lab-protocols"] } }]);
    });
});

describe("createFileCatalog — skills", () => {
    test("a custom skill is listed beside the built-in skills, and a custom skill with a built-in name is left out", async () => {
        writeSkill(builtinSkillsDir, "single-cell", "The built-in single-cell skill.");
        writeSkill(userSkillsDir, "single-cell", "A custom copy.");
        writeSkill(userSkillsDir, "lab-protocols", "Protocols of the lab.");
        const catalog = catalogOver(() => config());

        const skills = await catalog.skills.list();

        expect([...skills].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
            { name: "lab-protocols", description: "Protocols of the lab." },
            { name: "single-cell", description: "The built-in single-cell skill." },
        ]);
    });
});

describe("createFileCatalog — MCP servers", () => {
    test("a credential reference in `env` and in `headers` resolves to the value of the credential", async () => {
        const catalog = catalogOver(() =>
            config({
                mcp: {
                    github: { type: "http", url: "https://gh.example/mcp", headers: { Authorization: "Bearer ${cred:github}" } },
                    lims: { type: "stdio", command: "lims-mcp", args: ["--ro"], env: { LIMS_TOKEN: "${cred:github}", LIMS_MODE: "read" } },
                },
            }),
        );

        expect(await catalog.mcpServers()).toEqual([
            {
                name: "github",
                transport: { kind: "http", url: "https://gh.example/mcp", headers: { Authorization: "Bearer gh-token" }, auth: undefined },
                approval: "never",
                scriptable: false,
            },
            {
                name: "lims",
                transport: { kind: "stdio", command: "lims-mcp", args: ["--ro"], env: { LIMS_TOKEN: "gh-token", LIMS_MODE: "read" } },
                approval: "never",
                scriptable: false,
            },
        ]);
    });

    test("a disabled entry, an entry with an invalid name, and an entry that does not parse are left out", async () => {
        const catalog = catalogOver(() =>
            config({
                mcp: {
                    "lab.lims": { type: "stdio", command: "lims-mcp" },
                    off: { type: "stdio", command: "off-mcp", enabled: false },
                    broken: { type: "sse", url: "https://x.example" },
                    lims: { type: "stdio", command: "lims-mcp" },
                },
            }),
        );

        expect((await catalog.mcpServers()).map((server) => server.name)).toEqual(["lims"]);
        expect(catalog.mcpRecords().map((record) => [record.name, "problem" in record])).toEqual([
            ["lab.lims", true],
            ["off", false],
            ["broken", true],
            ["lims", false],
        ]);
    });

    test("an `oauth` entry gets the provider of its name and its URL", async () => {
        const signIns: [string, string][] = [];
        const provider = createMcpOAuthProvider({
            server: "lims",
            url: "https://lims.example/mcp",
            store: createMcpTokenStore({ platform: "linux", filePath: join(root, "mcp-tokens.json") }),
        });
        const catalog = catalogOver(
            () => config({ mcp: { lims: { type: "http", url: "https://lims.example/mcp", auth: "oauth" } } }),
            (server, url) => {
                signIns.push([server, url]);
                return provider;
            },
        );

        const [server] = await catalog.mcpServers();

        expect(signIns).toEqual([["lims", "https://lims.example/mcp"]]);
        expect(server?.transport).toMatchObject({ kind: "http", auth: provider });
    });
});

describe("isValidMcpServerName", () => {
    test.each(["lims", "lims-2", "0lims", "a".repeat(32)])("%s is valid", (name) => {
        expect(isValidMcpServerName(name)).toBe(true);
    });

    test.each(["", "lab.lims", "-lims", "Lims", "lims_query", "a".repeat(33)])("%s is not valid", (name) => {
        expect(isValidMcpServerName(name)).toBe(false);
    });
});
