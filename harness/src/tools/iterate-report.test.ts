import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import {
    createReportSubmitTool,
    submitReportInputSchema,
    planReportTool,
    ReportBriefSchema,
    stagedAssetsBlock,
    type SubmitReportDeps,
} from "./iterate-report.js";
import { passthroughStep } from "../loop/run-step.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "../loop/__fixtures__/scripted-provider.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import type { ChatProvider } from "../providers/types.js";
import type { ToolContext } from "./define-tool.js";
import type { PreviewPublisher } from "./report/preview-publisher.js";
import { UnavailablePreviewPublisher } from "./report/preview-publisher.js";

// ── ReportBriefSchema — the brief the conversation agent composes ────

describe("ReportBriefSchema", () => {
    test("accepts a v1 creation brief", () => {
        const result = ReportBriefSchema.safeParse({
            title: "Hello",
            audience: "Analysts",
            sources: [],
            sections: [{ type: "narrative", title: "Intro", intent: "Hero", content: { prose: "Welcome." } }],
        });
        expect(result.success).toBe(true);
    });

    test("rejects a chart section with both dataAsset and inline data", () => {
        const result = ReportBriefSchema.safeParse({
            title: "T",
            audience: "A",
            sources: [],
            sections: [
                {
                    type: "chart",
                    title: "Chart",
                    intent: "vis",
                    content: {
                        dataAsset: "x.csv",
                        data: { columns: ["a"], rows: [{ a: 1 }], source: "from x.csv" },
                        chartType: "bar",
                        encoding: { x: "a" },
                    },
                },
            ],
        });
        expect(result.success).toBe(false);
    });
});

// ── submit_report envelope — the always-on typed surface ────────────

describe("submitReportInputSchema", () => {
    test("rejects when neither report nor modifications is provided", () => {
        const result = submitReportInputSchema.safeParse({ format: "html" });
        expect(result.success).toBe(false);
    });

    test("rejects when both report and modifications are provided", () => {
        const result = submitReportInputSchema.safeParse({ report: { anything: true }, modifications: "tweak it" });
        expect(result.success).toBe(false);
    });

    test("accepts a v2+ iteration payload (modifications + previewId)", () => {
        const result = submitReportInputSchema.safeParse({ previewId: "prv-abc12345", modifications: "Add a chart for the QC metrics." });
        expect(result.success).toBe(true);
    });

    test("rejects creation with a top-level sources array", () => {
        const result = submitReportInputSchema.safeParse({ report: { anything: true }, sources: [{ path: "runs/r/output/x.csv" }] });
        expect(result.success).toBe(false);
    });

    test("rejects previewId containing path traversal segments", () => {
        const result = submitReportInputSchema.safeParse({ previewId: "../../../etc/passwd", modifications: "tweak it" });
        expect(result.success).toBe(false);
    });

    test("rejects previewId with slashes or uppercase or non-ASCII", () => {
        for (const bad of ["prv/abc", "prv-ABC", "prv abc", "prv-é"]) {
            const result = submitReportInputSchema.safeParse({ previewId: bad, modifications: "tweak it" });
            expect(result.success).toBe(false);
        }
    });

    test("rejects baseVersion of 0", () => {
        const result = submitReportInputSchema.safeParse({ previewId: "prv-abc12345", baseVersion: 0, modifications: "tweak it" });
        expect(result.success).toBe(false);
    });

    test("rejects a non-HTML format — HTML is the only artifact the path renders", () => {
        const result = submitReportInputSchema.safeParse({ previewId: "prv-abc12345", format: "pdf", modifications: "tweak it" });
        expect(result.success).toBe(false);
    });
});

// ── plan_report — the just-in-time authoring contract ───────────────

describe("planReportTool", () => {
    test("is a tiny always-on trigger whose schema carries no brief", () => {
        expect(planReportTool.id).toBe("plan_report");
        expect((planReportTool.jsonSchema as { type?: unknown }).type).toBe("object");
        const schemaChars = JSON.stringify(planReportTool.jsonSchema);
        expect(schemaChars.length).toBeLessThan(200);
        expect(schemaChars).not.toContain("sections");
    });

    test("execute returns the brief schema + authoring rules as its result", async () => {
        const result = await planReportTool.execute(
            {},
            makeCtx(() => {}),
        );
        expect(result.isOk()).toBe(true);
        const value = result._unsafeUnwrap() as { schema: unknown; rules: string };
        // The brief schema rides in the RESULT, not the always-on tool surface.
        expect(JSON.stringify(value.schema)).toContain("sections");
        expect(typeof value.rules).toBe("string");
        expect(value.rules).toContain("Markdown is NOT a source");
        expect(value.rules).toContain("run_ephemeral");
    });
});

// ── submit_report factory — id + thinned always-on schema ───────────

describe("createReportSubmitTool factory", () => {
    test("returns a tool with the expected id and object-shaped schema", () => {
        const tool = makeSubmitTool(stubProvider());
        expect(tool.id).toBe("submit_report");
        expect((tool.jsonSchema as { type?: unknown }).type).toBe("object");
    });

    test("keeps the ~12k brief schema OFF the always-on surface", () => {
        const tool = makeSubmitTool(stubProvider());
        const chars = JSON.stringify(tool.jsonSchema);
        // The brief's deep vocabulary must not ride the always-on schema.
        expect(chars).not.toContain("chartType");
        expect(chars).not.toContain("narrative");
        expect(chars).not.toContain("imageAsset");
        // Order-of-magnitude smaller than the former single tool (~12.6k).
        expect(chars.length).toBeLessThan(4000);
    });
});

// ── submit_report execute — behaviour is the former iterate_report ───

describe("createReportSubmitTool execute", () => {
    test("a VALID create brief stages sources, builds v1, and emits a preview", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        await mkdir(join(workspaceRoot, "runs", "r", "output"), { recursive: true });
        await writeFile(join(workspaceRoot, "runs", "r", "output", "data.csv"), "gene,value\nBRCA1,3\nTP53,5\n", "utf8");

        // Script the builder to write index.html directly and finalize via its
        // own submit_report — keeps the assertion on submit_report's wrapper
        // behaviour, not on Nunjucks rendering.
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("w1", "write_file", { path: "index.html", content: "<html><body>OK</body></html>" })], "tool_use"),
            makeMessage([toolUseBlock("s1", "submit_report", { notes: ["shipped clean"] })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const tool = makeSubmitTool(provider, workspaceRoot);

        const events: Array<{ type: string; data?: { version?: number } }> = [];
        const input = submitReportInputSchema.parse({
            report: {
                title: "QC Report",
                audience: "Analysts",
                sources: [{ path: "runs/r/output/data.csv" }],
                sections: [
                    {
                        type: "chart",
                        title: "Values",
                        intent: "Hero",
                        content: { dataAsset: "data.csv", chartType: "bar", encoding: { x: "gene", y: "value" } },
                    },
                ],
            },
        });
        const result = await tool.execute(
            input,
            makeCtx((e) => events.push(e as { type: string }), resourceId),
        );

        expect(result.isOk()).toBe(true);
        const value = result._unsafeUnwrap() as { previewId: string; version: number; previewPath: string };
        expect(value.previewId.startsWith("prv-")).toBe(true);
        expect(value.version).toBe(1);
        expect(value.previewPath).toBe("v1/index.html");

        // The declared source was staged into the shared assets/ dir.
        const staged = await stat(join(workspaceRoot, "previews", value.previewId, "assets", "data.csv"));
        expect(staged.isFile()).toBe(true);

        // A preview card was emitted for v1.
        const preview = events.find((e) => e.type === "data-report-preview");
        expect(preview?.data?.version).toBe(1);
    });

    test("an INVALID brief returns { ok:false, issues } as data — no throw, no preview dir", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        const tool = makeSubmitTool(stubProvider(), workspaceRoot);

        // Missing `audience` and `sections` — the brief fails ReportBriefSchema.
        const input = submitReportInputSchema.parse({ report: { title: "T" } });
        const result = await tool.execute(
            input,
            makeCtx(() => {}, resourceId),
        );

        expect(result.isOk()).toBe(true);
        const value = result._unsafeUnwrap() as { ok?: false; issues?: Array<{ path: string; message: string }> };
        expect(value.ok).toBe(false);
        expect(Array.isArray(value.issues)).toBe(true);
        const paths = (value.issues ?? []).map((i) => i.path);
        expect(paths.some((p) => p === "audience" || p === "sections")).toBe(true);

        // Short-circuited before any filesystem work — no previews/ tree.
        let created = true;
        try {
            await stat(join(workspaceRoot, "previews"));
        } catch {
            created = false;
        }
        expect(created).toBe(false);
    });

    // `report` rides the wire as `z.unknown()`, so a double-encoded brief satisfies
    // the tool's input schema and never reaches the agent loop's repair pass. Left
    // unrepaired here it produced an unbreakable retry loop: the model was told to
    // "pass the object directly", believed it already had, and resubmitted verbatim.
    test("a DOUBLE-ENCODED brief is repaired and builds v1", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        await mkdir(join(workspaceRoot, "runs", "r", "output"), { recursive: true });
        await writeFile(join(workspaceRoot, "runs", "r", "output", "data.csv"), "gene,value\nBRCA1,3\n", "utf8");

        const provider = scriptedProvider([
            makeMessage([toolUseBlock("w1", "write_file", { path: "index.html", content: "<html><body>OK</body></html>" })], "tool_use"),
            makeMessage([toolUseBlock("s1", "submit_report", {})], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const tool = makeSubmitTool(provider, workspaceRoot);

        const brief = {
            title: "QC Report",
            audience: "Analysts",
            sources: [{ path: "runs/r/output/data.csv" }],
            sections: [{ type: "narrative", title: "Intro", intent: "Hero", content: { prose: "Welcome." } }],
        };
        const input = submitReportInputSchema.parse({ report: JSON.stringify(brief) });
        const result = await tool.execute(
            input,
            makeCtx(() => {}, resourceId),
        );

        expect(result.isOk()).toBe(true);
        const value = result._unsafeUnwrap() as { ok?: false; version?: number; previewPath?: string };
        expect(value.ok).not.toBe(false);
        expect(value.version).toBe(1);
        expect(value.previewPath).toBe("v1/index.html");
    });

    test("a double-encoded brief that decodes to an INVALID one reports the decoded issues", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        const tool = makeSubmitTool(stubProvider(), workspaceRoot);

        // Decodes cleanly, but `audience` and `sections` are still missing. The
        // model must hear about those, not about the encoding this call repaired.
        const input = submitReportInputSchema.parse({ report: JSON.stringify({ title: "T" }) });
        const result = await tool.execute(
            input,
            makeCtx(() => {}, resourceId),
        );

        const value = result._unsafeUnwrap() as { ok?: false; issues?: Array<{ path: string }> };
        expect(value.ok).toBe(false);
        const paths = (value.issues ?? []).map((i) => i.path);
        expect(paths.some((p) => p === "audience" || p === "sections")).toBe(true);
        expect(paths).not.toContain("(root)");
    });

    test("a non-JSON string brief keeps its original failure", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        const tool = makeSubmitTool(stubProvider(), workspaceRoot);

        const input = submitReportInputSchema.parse({ report: "please build me a report" });
        const result = await tool.execute(
            input,
            makeCtx(() => {}, resourceId),
        );

        const value = result._unsafeUnwrap() as { ok?: false; issues?: Array<{ path: string }> };
        expect(value.ok).toBe(false);
        expect((value.issues ?? []).map((i) => i.path)).toContain("(root)");
    });

    test("iterate mode (modifications + previewId, no brief) builds the next version", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        const previewId = "prv-iter";
        const v1Dir = join(workspaceRoot, "previews", previewId, "v1");
        await mkdir(v1Dir, { recursive: true });
        await writeFile(join(v1Dir, "index.html"), "<html>v1</html>", "utf8");

        const provider = scriptedProvider([
            makeMessage([toolUseBlock("w1", "write_file", { path: "index.html", content: "<html><body>v2</body></html>" })], "tool_use"),
            makeMessage([toolUseBlock("s1", "submit_report", { notes: [] })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const tool = makeSubmitTool(provider, workspaceRoot);

        const input = submitReportInputSchema.parse({ previewId, modifications: "Add a QC chart." });
        const result = await tool.execute(
            input,
            makeCtx(() => {}, resourceId),
        );

        expect(result.isOk()).toBe(true);
        const value = result._unsafeUnwrap() as { version: number };
        expect(value.version).toBe(2);
    });

    test("iterating a preview whose latest version is 2 builds v3 from v2's template", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        const previewId = "prv-two";
        const previewRoot = join(workspaceRoot, "previews", previewId);
        await mkdir(join(previewRoot, "v1"), { recursive: true });
        await writeFile(join(previewRoot, "v1", "report.html.j2"), "<html><body>v1 template</body></html>", "utf8");
        await mkdir(join(previewRoot, "v2"), { recursive: true });
        await writeFile(join(previewRoot, "v2", "report.html.j2"), "<html><body>v2 template</body></html>", "utf8");

        const provider = scriptedProvider([
            makeMessage([toolUseBlock("w1", "write_file", { path: "index.html", content: "<html><body>v3</body></html>" })], "tool_use"),
            makeMessage([toolUseBlock("s1", "submit_report", { notes: [] })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const tool = makeSubmitTool(provider, workspaceRoot);

        const input = submitReportInputSchema.parse({ previewId, modifications: "Add a QC chart." });
        const result = await tool.execute(
            input,
            makeCtx(() => {}, resourceId),
        );

        const value = result._unsafeUnwrap() as { version: number; previewPath: string };
        expect(value.version).toBe(3);
        expect(value.previewPath).toBe("v3/index.html");
        // Branched from the latest version, not the first one.
        expect(await readFile(join(previewRoot, "v3", "report.html.j2"), "utf8")).toContain("v2 template");
    });

    // Iteration hands the builder a change request and the previous template and
    // nothing else, so a previewId with no version behind it has nothing to
    // modify — it must be refused, never turned into a fresh v1.
    test("iterating a previewId with no preview directory fails and builds nothing", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        // A provider with no `chat`: had the check not fired, constructing the
        // builder would have failed on this instead of returning the refusal.
        const tool = makeSubmitTool(stubProvider(), workspaceRoot);

        const events: Array<{ type: string; data?: { version?: number } }> = [];
        const input = submitReportInputSchema.parse({ previewId: "prv-nosuch", modifications: "Add a QC chart." });
        const result = await tool.execute(
            input,
            makeCtx((e) => events.push(e as { type: string }), resourceId),
        );

        expect(result.isOk()).toBe(true);
        const value = result._unsafeUnwrap() as { previewId: string; version: number; previewPath: string; error?: string };
        expect(value.version).toBe(0);
        expect(value.previewPath).toBe("");
        expect(value.error).toContain("prv-nosuch");
        expect(value.error).toContain("preview card");
        expect(await pathExists(join(workspaceRoot, "previews", "prv-nosuch"))).toBe(false);

        const failed = events.find((e) => e.type === "data-report-preview-failed");
        expect(failed?.data?.version).toBe(0);
    });

    test("iterating a preview directory that holds no version fails rather than minting v1", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        const previewId = "prv-empty";
        await mkdir(join(workspaceRoot, "previews", previewId, "assets"), { recursive: true });
        const tool = makeSubmitTool(stubProvider(), workspaceRoot);

        const input = submitReportInputSchema.parse({ previewId, modifications: "Add a QC chart." });
        const result = await tool.execute(
            input,
            makeCtx(() => {}, resourceId),
        );

        const value = result._unsafeUnwrap() as { version: number; error?: string };
        expect(value.version).toBe(0);
        expect(value.error).toContain(previewId);
        expect(await pathExists(join(workspaceRoot, "previews", previewId, "v1"))).toBe(false);
    });

    test("a pdf request is refused at the input boundary and adds no version", async () => {
        const { workspaceRoot } = await setupWorkspace();
        const previewId = "prv-pdf";
        const v1Dir = join(workspaceRoot, "previews", previewId, "v1");
        await mkdir(v1Dir, { recursive: true });
        await writeFile(join(v1Dir, "index.html"), "<html>v1</html>", "utf8");

        const parsed = submitReportInputSchema.safeParse({ previewId, format: "pdf", modifications: "Re-render it as a PDF." });

        // Input validation runs ahead of `execute`, so the call never reaches the
        // builder and the preview keeps the versions it had.
        expect(parsed.success).toBe(false);
        expect(await pathExists(join(workspaceRoot, "previews", previewId, "v2"))).toBe(false);
    });

    test("a preview recorded with format 'pdf' still parses on iteration", async () => {
        const { workspaceRoot, resourceId } = await setupWorkspace();
        const previewId = "prv-legacy";
        const previewRoot = join(workspaceRoot, "previews", previewId);
        await mkdir(join(previewRoot, "v1"), { recursive: true });
        await writeFile(join(previewRoot, "v1", "index.html"), "<html>v1</html>", "utf8");
        await writeFile(join(previewRoot, "preview-meta.json"), JSON.stringify({ title: "Legacy QC Report", audience: "Analysts", format: "pdf" }), "utf8");

        const provider = scriptedProvider([
            makeMessage([toolUseBlock("w1", "write_file", { path: "index.html", content: "<html><body>v2</body></html>" })], "tool_use"),
            makeMessage([toolUseBlock("s1", "submit_report", { notes: [] })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const tool = makeSubmitTool(provider, workspaceRoot);

        const events: Array<{ type: string; data?: { title?: string } }> = [];
        const input = submitReportInputSchema.parse({ previewId, modifications: "Add a QC chart." });
        const result = await tool.execute(
            input,
            makeCtx((e) => events.push(e as { type: string }), resourceId),
        );

        expect(result.isOk()).toBe(true);
        // The recorded title reached the preview card, so the stored `"pdf"`
        // parsed — a rejected meta file falls back to the generic "Report".
        const preview = events.find((e) => e.type === "data-report-preview");
        expect(preview?.data?.title).toBe("Legacy QC Report");
    });
});

// ── stagedAssetsBlock — brief-composition helper (unchanged) ─────────

describe("stagedAssetsBlock", () => {
    test("renders the no-assets fallback when staged is empty", () => {
        const out = stagedAssetsBlock([]);
        expect(out).toContain("Staged Assets");
        expect(out).toContain("No file assets");
    });

    test("escapes pipe characters in CSV head rows", () => {
        const out = stagedAssetsBlock([
            { name: "data.csv", path: "runs/r/output/data.csv", kind: "csv", sizeBytes: 100, columns: ["a", "b|c"], headRows: [["1", "two|three"]] },
        ]);
        expect(out).toContain("b\\|c");
        expect(out).toContain("two\\|three");
    });
});

// ── helpers ─────────────────────────────────────────────────────────

function stubProvider(): ChatProvider {
    return {} as ChatProvider;
}

function stubPreviews(): PreviewPublisher {
    return new UnavailablePreviewPublisher();
}

function makeSubmitTool(provider: ChatProvider, workspaceRoot = "/sessions") {
    const deps: SubmitReportDeps = {
        provider,
        pool: {} as Pool,
        resolveWorkspaceRoot: () => workspaceRoot,
        model: "anthropic/test",
        templatesDir: "/templates",
        chrome: {},
        createPreviewPublisher: async () => stubPreviews(),
    };
    return createReportSubmitTool(deps);
}

function makeCtx(emit: ToolContext["emit"], resourceId = "analysis-r"): ToolContext {
    return {
        session: makeSession({ scope: { kind: "analysis", analysisId: resourceId }, agentId: "conversation-agent", callPath: ["conversation-agent"] }),
        signal: new AbortController().signal,
        emit,
        runStep: passthroughStep,
    };
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function setupWorkspace() {
    const base = await mkdtemp(join(tmpdir(), "submit-report-test-"));
    const resourceId = "analysis-r";
    const workspaceRoot = join(base, resourceId);
    await mkdir(workspaceRoot, { recursive: true });
    return { workspaceRoot, resourceId };
}
