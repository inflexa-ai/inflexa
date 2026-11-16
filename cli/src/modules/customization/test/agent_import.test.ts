import { describe, expect, test } from "bun:test";
import type { ResolvedAgent } from "@inflexa-ai/harness";

import { agentIdOf, cloneDefinition, convertForeignAgent, mcpServerOfToolName } from "../agent_import.ts";

const NO_SERVERS: ReadonlySet<string> = new Set();
const LIMS: ReadonlySet<string> = new Set(["lims"]);

describe("convertForeignAgent", () => {
    test("a Claude Code file keeps the name, the description, and the prompt, and drops the model and the role tools", () => {
        const text = [
            "---",
            "name: Code Reviewer",
            "description: Reviews code.",
            "tools: Read, Bash, mcp__github__search_code",
            "model: sonnet",
            "---",
            "",
            "Review the diff.",
            "",
        ].join("\n");

        expect(convertForeignAgent(text, NO_SERVERS)._unsafeUnwrap()).toEqual({
            id: "code-reviewer",
            unmappedTools: [],
            definition: {
                id: "code-reviewer",
                name: "code-reviewer",
                role: "executor",
                description: "Reviews code.",
                prompt: "Review the diff.",
                connectors: [],
                mcp: ["github"],
                skills: [],
            },
        });
    });

    test("a Copilot file maps each `<server>/<tool>` name to its server, and drops the role tools", () => {
        const text = ["---", "name: lims-reader", "description: d", "tools: ['read', 'search', 'lims/query', 'lims/list']", "---", "", "p"].join("\n");

        expect(convertForeignAgent(text, NO_SERVERS)._unsafeUnwrap()).toMatchObject({ unmappedTools: [], definition: { mcp: ["lims"] } });
    });

    test("a Gemini CLI file maps each `mcp_<server>_<tool>` name to its server, and drops the role tools", () => {
        const text = ["---", "name: lims-reader", "description: d", "tools: [read_file, run_shell_command, mcp_lims_query]", "---", "", "p"].join("\n");

        expect(convertForeignAgent(text, NO_SERVERS)._unsafeUnwrap()).toMatchObject({ unmappedTools: [], definition: { mcp: ["lims"] } });
    });

    test("a tool that maps to nothing is kept as an unmapped tool", () => {
        const text = ["---", "name: notebook", "description: d", "tools: Read, NotebookEdit", "---", "", "p"].join("\n");

        const converted = convertForeignAgent(text, NO_SERVERS)._unsafeUnwrap();

        expect(converted).toMatchObject({ unmappedTools: ["NotebookEdit"], definition: { mcp: [] } });
    });

    test("a server named by the `mcpServers` field and again by a tool is listed once", () => {
        const text = ["---", "name: lims-reader", "description: d", "mcpServers: [lims]", "tools: [mcp__lims__query]", "---", "", "p"].join("\n");

        expect(convertForeignAgent(text, LIMS)._unsafeUnwrap()).toMatchObject({ definition: { mcp: ["lims"] } });
    });

    test("a server that the file defines inline becomes a reference by its name", () => {
        const text = ["---", "name: lims-reader", "description: d", "mcpServers:", "  - lims:", "      command: lims-mcp", "---", "", "p"].join("\n");

        expect(convertForeignAgent(text, NO_SERVERS)._unsafeUnwrap()).toMatchObject({ definition: { mcp: ["lims"] } });
    });

    test("a file that does not parse cannot convert", () => {
        expect(convertForeignAgent("no frontmatter", NO_SERVERS)._unsafeUnwrapErr()).toEqual({ type: "unreadable", gap: { type: "no_frontmatter" } });
    });

    test("a name with no letter or digit cannot convert", () => {
        const text = ["---", 'name: "!!"', "description: d", "---", "", "p"].join("\n");

        expect(convertForeignAgent(text, NO_SERVERS)._unsafeUnwrapErr()).toEqual({ type: "no_id" });
    });
});

describe("mcpServerOfToolName", () => {
    test.each(["mcp__lims__query", "mcp__lims__*", "lims/query", "mcp_lims_*", "lims_query"])("%s maps to the server lims", (name) => {
        expect(mcpServerOfToolName(name, LIMS)).toBe("lims");
    });

    test("a `<server>_<tool>` name maps only for a server that the config defines", () => {
        expect(mcpServerOfToolName("lims_query", NO_SERVERS)).toBeUndefined();
    });

    test("a plain tool name maps to no server", () => {
        expect(mcpServerOfToolName("NotebookEdit", LIMS)).toBeUndefined();
    });
});

describe("agentIdOf", () => {
    test.each([
        ["Code Reviewer", "code-reviewer"],
        ["lipid_analyst.v2", "lipid-analyst-v2"],
        ["--Lead--", "lead"],
        ["!!", ""],
    ])("%s gives the id %s", (name, id) => {
        expect(agentIdOf(name)).toBe(id);
    });
});

describe("cloneDefinition", () => {
    const analyst: ResolvedAgent = {
        id: "analyst",
        name: "Analyst",
        role: "executor",
        description: "Runs an analysis step.",
        prompt: "You are the analyst.",
        builtin: true,
        attachments: { connectors: ["pubmed"], mcp: ["lims"], skills: ["single-cell"] },
    };

    test("a clone of a built-in executor keeps its prompt, its description, and its attachments as resolved", () => {
        expect(cloneDefinition(analyst, "analyst", "my-analyst")._unsafeUnwrap()).toEqual({
            id: "my-analyst",
            name: "my-analyst",
            role: "executor",
            description: "Runs an analysis step.",
            prompt: "You are the analyst.",
            connectors: ["pubmed"],
            mcp: ["lims"],
            skills: ["single-cell"],
        });
    });

    test("a built-in agent that is not an executor cannot clone", () => {
        const planner: ResolvedAgent = { ...analyst, id: "planner", role: "planner", prompt: undefined };

        expect(cloneDefinition(planner, "planner", "my-planner")._unsafeUnwrapErr()).toEqual({ type: "not_an_executor", id: "planner" });
    });

    test("an id that is not a built-in agent cannot clone", () => {
        expect(cloneDefinition({ ...analyst, id: "lipid-analyst", builtin: false }, "lipid-analyst", "copy")._unsafeUnwrapErr()).toEqual({
            type: "unknown_agent",
            id: "lipid-analyst",
        });
        expect(cloneDefinition(undefined, "analyst", "copy")._unsafeUnwrapErr()).toEqual({ type: "unknown_agent", id: "analyst" });
    });
});
