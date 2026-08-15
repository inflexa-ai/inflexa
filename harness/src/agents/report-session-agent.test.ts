import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import type { Pool } from "pg";

import { createReportSessionAgent, REPORT_SESSION_AGENT_ID } from "./report-session-agent.js";
import { reportSessionPrompt } from "../prompts/report-session.js";
import { createRegistry } from "../tools/registry.js";
import type { EmbeddingProvider } from "../providers/types.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { ThreadStore } from "../memory/thread-store.js";
import type { ReportSessionStateStore } from "../state/report-session-state.js";
import type { ReportVersionStore } from "../state/report-versions.js";
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
        store: {} as ReportVersionStore,
        threads: {} as Pick<ThreadStore, "getThread">,
        chrome: {},
        derivations: {} as Pick<ReportSessionStateStore, "appendDerivation">,
    });
}

// The read surface toward the analysis. The roster roams the tree read-only.
const READ_SURFACE = ["read_file", "list_files", "file_stat", "grep", "workspace_search", "inspect_run", "inspect_data_profile"] as const;

// The composition surface: the eight authoring tools, the pinned-artifact listing
// tool, the derivation tool, the render-and-preview tool, the eyes tool, and the
// record tool. These thirteen ids are what makes the report path a report path.
const COMPOSITION_SURFACE = [
    "add_block",
    "change_block",
    "remove_block",
    "move_block",
    "set_title",
    "read_outline",
    "read_block",
    "finish_draft",
    "list_pinned_artifacts",
    "derive_table",
    "preview_report",
    "examine_page",
    "record_report_version",
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

    test("holds the thirteen composition tools", () => {
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

    test("the prompt teaches the verification loop and names the visual spiral", () => {
        // The loop order and the two verification tools are stable substrings, thus
        // the assertion does not couple to the full prose.
        expect(reportSessionPrompt).toContain("preview, look, repair");
        expect(reportSessionPrompt).toContain("examine_page");
        expect(reportSessionPrompt).toContain("record_report_version");
        // The record gate is the look, thus the substring carries that clause and
        // not the bare "only after" that a line wrap cuts.
        expect(reportSessionPrompt).toContain("you look at the current page");
        // The anti-pattern entry names the visual spiral.
        expect(reportSessionPrompt).toContain("visual spiral");
        expect(reportSessionPrompt).toContain("cosmetic doubt");
    });

    test("the look step carries the fault checklist", () => {
        // Each fault of the checklist is a stable substring, thus a look that judges
        // by taste alone cannot pass as guidance.
        expect(reportSessionPrompt).toContain("clipped text");
        expect(reportSessionPrompt).toContain("a truncated number");
        expect(reportSessionPrompt).toContain("an overflowing card");
        expect(reportSessionPrompt).toContain("a raw column name on an axis");
        expect(reportSessionPrompt).toContain("an unreadable precision");
        expect(reportSessionPrompt).toContain("a number that disagrees");
        expect(reportSessionPrompt).toContain("content that stayed invisible");
        // A found fault ends in a repair, thus the agent never reports one instead.
        expect(reportSessionPrompt).toContain("A found fault is a repair, and never a note");
        // The spiral warning reads against the same checklist, thus the two agree.
        expect(reportSessionPrompt).toContain("look checklist names");
    });

    test("the prompt names the listing tool as the orientation source and bans the hash probe", () => {
        // The path-only rule and its anti-pattern are stable substrings, thus the
        // assertion does not couple to the full prose.
        expect(reportSessionPrompt).toContain("list_pinned_artifacts");
        expect(reportSessionPrompt).toContain("orientation source");
        expect(reportSessionPrompt).toContain("names the path alone");
        expect(reportSessionPrompt).toContain("stamps the hash");
        expect(reportSessionPrompt).toContain("Probe for a hash");
    });

    test("the prompt teaches the citation blocks and their pinned-evidence bound", () => {
        // The citation rule and its anti-pattern are stable substrings, thus the
        // assertion does not couple to the full prose.
        expect(reportSessionPrompt).toContain("citation blocks");
        expect(reportSessionPrompt).toContain("citation id of the pinned evidence");
        expect(reportSessionPrompt).toContain("does not resolve");
        expect(reportSessionPrompt).toContain("Inline a citation that does not resolve");
        // The listing tool is the route to a pinned id, thus the agent never learns one from a refusal.
        expect(reportSessionPrompt).toContain("`citations` field");
        expect(reportSessionPrompt).toContain("never take an id out of a refusal");
    });

    test("the prompt carries the argument spine", () => {
        // The spine order and the two prose rules are stable substrings, thus the
        // assertion does not couple to the full prose.
        expect(reportSessionPrompt).toContain("compose the argument spine");
        expect(reportSessionPrompt).toContain("the findings, in order of strength");
        expect(reportSessionPrompt).toContain("the negative result, in its honest place");
        expect(reportSessionPrompt).toContain("the limits of the evidence");
        // The flow of a paper carries no chapter name of one.
        expect(reportSessionPrompt).toContain("never gives the chapter names");
        expect(reportSessionPrompt).toContain('"Abstract"');
        expect(reportSessionPrompt).toContain('"Literature review"');
        expect(reportSessionPrompt).toContain('"Prior work"');
        // Each section opens with its topic sentence, and no evidence precedes it.
        expect(reportSessionPrompt).toContain("opens with its topic sentence");
        expect(reportSessionPrompt).toContain("before the sentence that tells the reader what to see");
        expect(reportSessionPrompt).toContain("The evidence illustrates the prose");
        expect(reportSessionPrompt).toContain("The angle of the brief decides the order of the findings");
        // The anti-pattern entry names evidence that precedes its sentence.
        expect(reportSessionPrompt).toContain("Show evidence before its sentence");
    });

    test("the prompt divides a derivation from a chart knob", () => {
        // The tool name, the three reshaping cases, and the per-row bound are stable
        // substrings, thus the assertion does not couple to the full prose.
        expect(reportSessionPrompt).toContain("derive_table");
        expect(reportSessionPrompt).toContain("a pivot, and an aggregate are such reshaping");
        expect(reportSessionPrompt).toContain("transform is not: a chart block reads the column that it needs");
        // A derived table is evidence of the session, thus it binds like a pinned one.
        expect(reportSessionPrompt).toContain("binds like any pinned artifact");
    });

    test("the prompt carries the chart-first rule", () => {
        // The preference, its table condition, and the report-page bound are stable
        // substrings, thus the assertion does not couple to the full prose.
        expect(reportSessionPrompt).toContain("Prefer a chart block when a table artifact holds the data");
        expect(reportSessionPrompt).toContain("a figure image only when no table carries the data");
        expect(reportSessionPrompt).toContain("this rule is about the report page alone");
        // The anti-pattern entry names the figure that stands where a table serves.
        expect(reportSessionPrompt).toContain("Reach for a figure where a table serves");
    });

    test("the prompt carries the headline obligations", () => {
        // The cohort-and-yield lead, the caveat ban, the absence branch, the
        // contrast rule, and the rounding rule are stable substrings.
        expect(reportSessionPrompt).toContain("leads with the cohort and the yield");
        expect(reportSessionPrompt).toContain("the group split");
        expect(reportSessionPrompt).toContain("carries a caveat is not a headline");
        expect(reportSessionPrompt).toContain("the pinned evidence holds no cohort value");
        expect(reportSessionPrompt).toContain("headline leads with what the evidence gives");
        expect(reportSessionPrompt).toContain("The card set carries its own contrast");
        expect(reportSessionPrompt).toContain("Round a number in the prose to the short form");
        // The anti-pattern entry names the caveated headline.
        expect(reportSessionPrompt).toContain("Lead with a caveated value");
    });

    test("the definition carries no per-session value in the prompt", () => {
        const { systemPrompt } = buildAgent();
        // A per-session value (a thread id, an analysis id, a resolved path) breaks
        // the cacheable prefix. The report layer names only tools and rules.
        expect(systemPrompt).not.toContain("/sessions");
        expect(systemPrompt).not.toContain("report-sessions");
    });
});
