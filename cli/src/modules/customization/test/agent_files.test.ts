import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomAgent } from "@inflexa-ai/harness";

import { checkAgentFile, readAgentFiles, renderAgentFile, type AgentFileGap, type KnownReferences } from "../agent_files.ts";

const known: KnownReferences = {
    builtinIds: new Set(["analyst", "inflexa"]),
    connectors: new Set(["pubmed", "chembl"]),
    mcpServers: new Set(["lims"]),
    skills: new Set(["lab-protocols"]),
};

/** The text of an agent file: the frontmatter lines between the fences, then the prompt. */
function agentText(frontmatter: readonly string[], prompt = "Analyze the lipids."): string {
    return `---\n${frontmatter.join("\n")}\n---\n\n${prompt}\n`;
}

const VALID = agentText([
    "name: lipid-analyst",
    "description: Analyzes lipid panels.",
    "connectors: [pubmed]",
    "mcpServers: [lims]",
    "skills: [lab-protocols]",
]);

describe("checkAgentFile", () => {
    test("a valid file is an executor with its prompt and its attachments", () => {
        expect(checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", VALID, known)).toEqual({
            status: "ok",
            id: "lipid-analyst",
            path: "/a/lipid-analyst.md",
            definition: {
                id: "lipid-analyst",
                name: "lipid-analyst",
                role: "executor",
                description: "Analyzes lipid panels.",
                prompt: "Analyze the lipids.",
                connectors: ["pubmed"],
                mcp: ["lims"],
                skills: ["lab-protocols"],
            },
        });
    });

    test("a model field is ignored, thus the file stays valid and the definition carries no model", () => {
        const file = checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", agentText(["name: lipid-analyst", "description: d", "model: opus"]), known);

        expect(file.status).toBe("ok");
        expect(file.definition).not.toHaveProperty("model");
    });

    test.each<[string, string, AgentFileGap]>([
        ["no frontmatter", "Just a prompt.\n", { type: "no_frontmatter" }],
        ["no description", agentText(["name: lipid-analyst"]), { type: "missing_fields", detail: "description" }],
    ])("a file with %s is a draft with that gap", (_label, text, gap) => {
        expect(checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", text, known)).toEqual({
            status: "draft",
            id: "lipid-analyst",
            path: "/a/lipid-analyst.md",
            gaps: [gap],
        });
    });

    test("frontmatter that does not parse is a draft with the parse error", () => {
        const file = checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", agentText(["name: [lipid-analyst", "description: d"]), known);

        expect(file).toMatchObject({ status: "draft", gaps: [{ type: "invalid_yaml" }] });
    });

    test("a name that is not the file name is a draft", () => {
        const file = checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", agentText(["name: other", "description: d"]), known);

        expect(file).toMatchObject({ status: "draft", gaps: [{ type: "name_mismatch", name: "other" }] });
    });

    test("the id of a built-in agent is a draft", () => {
        const file = checkAgentFile("analyst", "/a/analyst.md", agentText(["name: analyst", "description: d"]), known);

        expect(file).toMatchObject({ status: "draft", gaps: [{ type: "builtin_id" }] });
    });

    test("a file of any role resolves, and a role that the harness does not have is a draft", () => {
        const planner = checkAgentFile("my-planner", "/a/my-planner.md", agentText(["name: my-planner", "description: d", "role: planner"]), known);
        const unknown = checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", agentText(["name: lipid-analyst", "description: d", "role: wizard"]), known);

        expect(planner).toMatchObject({ status: "ok", definition: { role: "planner" } });
        expect(unknown).toMatchObject({ status: "draft", gaps: [{ type: "unknown_role", role: "wizard" }] });
    });

    test("each unknown connector, MCP server, and skill is a gap that names it", () => {
        const text = agentText(["name: lipid-analyst", "description: d", "connectors: [lipidbank]", "mcpServers: [lipidmaps]", "skills: [lipidomics]"]);

        expect(checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", text, known)).toMatchObject({
            status: "draft",
            gaps: [
                { type: "unknown_connector", name: "lipidbank" },
                { type: "unknown_mcp_server", name: "lipidmaps" },
                { type: "unknown_skill", name: "lipidomics" },
            ],
        });
    });

    test("an MCP server that the file defines inline is a gap that names it, and the file stays readable", () => {
        const text = agentText(["name: lipid-analyst", "description: d", "mcpServers:", "  - lims", "  - lipidmaps:", "      command: lipidmaps-mcp"]);

        expect(checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", text, known)).toMatchObject({
            status: "draft",
            gaps: [{ type: "inline_mcp_server", name: "lipidmaps" }],
            definition: { mcp: ["lims", "lipidmaps"] },
        });
    });

    test("each tool of a `tools` field is a gap, in the YAML list form and in the comma form", () => {
        const listForm = checkAgentFile("lipid-analyst", "/a/x.md", agentText(["name: lipid-analyst", "description: d", "tools: [NotebookEdit]"]), known);
        const commaForm = checkAgentFile(
            "lipid-analyst",
            "/a/x.md",
            agentText(["name: lipid-analyst", "description: d", "tools: NotebookEdit, WebFetch"]),
            known,
        );

        expect(listForm).toMatchObject({ status: "draft", gaps: [{ type: "tool_not_mapped", name: "NotebookEdit" }] });
        expect(commaForm).toMatchObject({
            status: "draft",
            gaps: [
                { type: "tool_not_mapped", name: "NotebookEdit" },
                { type: "tool_not_mapped", name: "WebFetch" },
            ],
        });
    });
});

describe("renderAgentFile", () => {
    const definition: CustomAgent = {
        id: "lipid-analyst",
        name: "lipid-analyst",
        role: "executor",
        description: "Analyzes lipid panels.",
        prompt: "Analyze the lipids.",
        connectors: ["pubmed"],
        mcp: ["lims"],
        skills: ["lab-protocols"],
    };

    test("a rendered file reads back as the same definition", () => {
        const file = checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", renderAgentFile(definition), known);

        expect(file).toEqual({ status: "ok", id: "lipid-analyst", path: "/a/lipid-analyst.md", definition });
    });

    test("the unmapped tools stay under `tools`, thus the file reads back as a draft that names each", () => {
        const file = checkAgentFile("lipid-analyst", "/a/lipid-analyst.md", renderAgentFile(definition, ["NotebookEdit"]), known);

        expect(file).toEqual({
            status: "draft",
            id: "lipid-analyst",
            path: "/a/lipid-analyst.md",
            gaps: [{ type: "tool_not_mapped", name: "NotebookEdit" }],
            definition,
        });
    });
});

describe("readAgentFiles", () => {
    let dir = "";
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "inflexa-agent-files-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("an absent directory has no agents", () => {
        expect(readAgentFiles(join(dir, "absent"), known)).toEqual([]);
    });

    test("each `.md` file is checked under the id of its file name, and a file of another kind is left out", () => {
        writeFileSync(join(dir, "lipid-analyst.md"), VALID);
        writeFileSync(join(dir, "broken.md"), "no frontmatter\n");
        writeFileSync(join(dir, "notes.txt"), VALID);
        mkdirSync(join(dir, "nested"));

        const files = readAgentFiles(dir, known);

        expect(files.map((file) => [file.id, file.status])).toEqual([
            ["broken", "draft"],
            ["lipid-analyst", "ok"],
        ]);
    });

    // Two files give one id only through a case difference, thus the case needs a file system that keeps case.
    const caseInsensitive = ((): boolean => {
        const probe = mkdtempSync(join(tmpdir(), "inflexa-case-probe-"));
        writeFileSync(join(probe, "Probe"), "");
        const insensitive = existsSync(join(probe, "probe"));
        rmSync(probe, { recursive: true, force: true });
        return insensitive;
    })();

    test.skipIf(caseInsensitive)("two files that give one id are each a draft with the duplicate gap", () => {
        writeFileSync(join(dir, "lipid-analyst.md"), VALID);
        writeFileSync(join(dir, "Lipid-analyst.md"), agentText(["name: Lipid-analyst", "description: d"]));

        const files = readAgentFiles(dir, known);

        expect(files.map((file) => file.status)).toEqual(["draft", "draft"]);
        for (const file of files) expect(file.status === "draft" ? file.gaps : []).toContainEqual({ type: "duplicate_id" });
    });
});
