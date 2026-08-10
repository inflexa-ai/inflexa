import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import type { Pool } from "pg";

import { createReportSessionAgent, REPORT_SESSION_AGENT_ID } from "./report-session-agent.js";
import { reportSessionPrompt } from "../prompts/report-session.js";
import { createRegistry } from "../tools/registry.js";
import type { EmbeddingProvider } from "../providers/types.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { ReportSessionStateGateway } from "../tools/report-authoring/authoring-tools.js";

// The composition root closes over its deps but never touches them at
// construction — every factory just calls `defineTool`. Bare stubs suffice for
// asserting the assembled `AgentDefinition`'s shape.
function buildAgent() {
    return createReportSessionAgent({
        model: "anthropic/claude-opus-4-8",
        pool: {} as Pool,
        embedding: {} as EmbeddingProvider,
        workspaceFs: {} as WorkspaceFilesystem,
        gateway: {} as ReportSessionStateGateway,
        resolveWorkspaceRoot: (id: string) => join("/sessions", id),
    });
}

// The read surface toward the analysis. The roster roams the tree read-only.
const READ_SURFACE = ["read_file", "list_files", "file_stat", "grep", "workspace_search", "inspect_run", "inspect_data_profile"] as const;

// The composition surface: the eight authoring tools and the render-and-preview
// tool. These nine ids are what makes the report path a report path.
const COMPOSITION_SURFACE = [
    "add_block",
    "change_block",
    "remove_block",
    "move_block",
    "set_title",
    "read_outline",
    "read_block",
    "finish_draft",
    "preview_report",
] as const;

// A tool that starts a run or writes an analysis has no place on this roster. Its
// absence is the whole guarantee — no runtime guard blocks these; the roster omits
// them.
const FORBIDDEN = [
    "generate_plan",
    "execute_analysis",
    "plan_report",
    "submit_report",
    "write_file",
    "edit_file",
    "execute_command",
    "update_working_memory",
] as const;

describe("createReportSessionAgent", () => {
    test("assembles the report AgentDefinition with the report-session id", () => {
        const agent = buildAgent();
        expect(agent.id).toBe(REPORT_SESSION_AGENT_ID);
        expect(agent.id).toBe("report-session");
        expect(agent.model).toBe("anthropic/claude-opus-4-8");
        // The report turn drives many small tool calls, the same headroom the
        // conversation agent uses.
        expect(agent.maxIterations).toBe(50);
    });

    test("holds the analysis read surface", () => {
        const ids = new Set(buildAgent().tools.map((tool) => tool.id));
        for (const expected of READ_SURFACE) {
            expect(ids.has(expected)).toBe(true);
        }
    });

    test("holds the nine composition tools", () => {
        const ids = new Set(buildAgent().tools.map((tool) => tool.id));
        for (const expected of COMPOSITION_SURFACE) {
            expect(ids.has(expected)).toBe(true);
        }
    });

    test("holds no run starter and no mutate tool", () => {
        const ids = new Set(buildAgent().tools.map((tool) => tool.id));
        for (const forbidden of FORBIDDEN) {
            expect(ids.has(forbidden)).toBe(false);
        }
    });

    test("holds exactly the read surface and the composition surface, and no more", () => {
        const ids = buildAgent().tools.map((tool) => tool.id);
        // The roster is the whole guarantee — assert the exact set, so a later
        // wiring that adds a run starter or a mutate tool fails here.
        expect(new Set(ids)).toEqual(new Set([...READ_SURFACE, ...COMPOSITION_SURFACE]));
    });

    test("tool ids are unique", () => {
        const agent = buildAgent();
        // createRegistry throws on a duplicate id.
        const registry = createRegistry(agent.tools);
        expect(Object.keys(registry.definitions())).toHaveLength(agent.tools.length);
    });

    test("the system prompt composes SOUL with the identity and the conversational layers", () => {
        const { systemPrompt } = buildAgent();
        expect(systemPrompt).toContain("# SOUL — Execution Core");
        expect(systemPrompt).toContain("# SOUL — Identity");
        expect(systemPrompt).toContain("# SOUL — Conversational Style");
        expect(systemPrompt).toContain("# Report Builder");
    });

    test("the prompt module names no path, no format, and no dataset", () => {
        // A reviewer reads the module: no location, no format promise, no dataset
        // name. A slash is the first sign of a path or a slash-shaped format.
        expect(reportSessionPrompt).not.toContain("/");
        for (const format of ["HTML", "CSV", "JSON", ".html", ".md"]) {
            expect(reportSessionPrompt.toLowerCase()).not.toContain(format.toLowerCase());
        }
        for (const dataset of ["MSigDB", "CollecTRI"]) {
            expect(reportSessionPrompt).not.toContain(dataset);
        }
        // The grounding rule is explicit: no number from memory.
        expect(reportSessionPrompt).toContain("never from memory");
    });

    test("the definition carries no per-session value in the prompt", () => {
        const { systemPrompt } = buildAgent();
        // A per-session value (a thread id, an analysis id, a resolved path) breaks
        // the cacheable prefix. The report layer names only tools and rules.
        expect(systemPrompt).not.toContain("/sessions");
        expect(systemPrompt).not.toContain("report-sessions");
    });
});
