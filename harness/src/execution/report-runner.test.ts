import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "../loop/__fixtures__/scripted-provider.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import { runReportIteration } from "./report-runner.js";
import type { PreviewPublisher } from "../tools/report/preview-publisher.js";

/**
 * Build a stub PreviewPublisher. The report-runner only calls
 * `mintPreviewAccess` via the `preview_snapshot` / `mint_preview_url` tools —
 * the happy-path test doesn't drive those tools, so this can be permissive.
 */
function stubPreviews(): PreviewPublisher {
    return {
        async mintPreviewAccess() {
            return {
                ok: true as const,
                data: {
                    baseUrl: "http://content-server/previews/",
                    token: "tok-test",
                    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                },
            };
        },
    };
}

const NO_POOL = {} as Pool;

async function setupSession() {
    const base = await mkdtemp(join(tmpdir(), "report-runner-test-"));
    const resourceId = "analysis-r";
    const workspaceRoot = join(base, resourceId);
    await mkdir(workspaceRoot, { recursive: true });
    // Provide a minimal templates dir; build_report reads echarts-theme.json.
    return { workspaceRoot, resourceId };
}

describe("runReportIteration (closure-state outcome)", () => {
    test("captures success via the submit-report closure write", async () => {
        const { workspaceRoot, resourceId } = await setupSession();
        const previewId = "prv-success";

        // Script the report-builder to:
        //   1. write_file(report.html.j2) — the report itself, which
        //      submit_report requires — plus index.html seeded directly rather
        //      than rendered, keeping the test independent of Nunjucks.
        //   2. submit_report({notes}) — terminal write into the closure outcome.
        //   3. end_turn with a final text block.
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("t1", "write_file", {
                        path: "report.html.j2",
                        content: "<html><body>stub template</body></html>",
                    }),
                    toolUseBlock("w1", "write_file", {
                        path: "index.html",
                        content: "<html><body>OK</body></html>",
                    }),
                ],
                "tool_use",
            ),
            makeMessage(
                [
                    toolUseBlock("s1", "submit_report", {
                        notes: ["shipped clean"],
                    }),
                ],
                "tool_use",
            ),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const session = makeSession({
            scope: { kind: "analysis", analysisId: resourceId },
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        });

        const events: unknown[] = [];
        const result = await runReportIteration(
            {
                provider,
                pool: NO_POOL,
                model: "anthropic/test",
                templatesDir: "/templates",
                skillsDir: "/skills",
                chrome: {},
            },
            {
                resourceId,
                workspaceRoot,
                previews: stubPreviews(),
                previewId,
                format: "html",
                prompt: "build a v1 report",
                session,
                signal: new AbortController().signal,
                emit: (e) => {
                    events.push(e);
                },
            },
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.previewId).toBe(previewId);
            expect(result.version).toBe(1);
            expect(result.previewPath).toBe("v1/index.html");
            expect(result.notes).toEqual(["shipped clean"]);
        }

        // The version dir survived (not rolled back) and contains index.html.
        const indexStat = await stat(join(workspaceRoot, "previews", previewId, "v1", "index.html"));
        expect(indexStat.isFile()).toBe(true);

        // The child agent ran with the forSubAgent provenance.
        expect(provider.sessions[0]!.provenance.agentId).toBe("report-builder");
        expect(provider.sessions[0]!.provenance.callPath).toEqual(["conversation-agent", "report-builder"]);
    });

    test("rolls back when the builder ends without calling submit_report", async () => {
        const { workspaceRoot, resourceId } = await setupSession();
        const previewId = "prv-no-submit";

        // Agent writes something but never calls submit_report — closure-state
        // `outcome` stays `undefined`, runner classifies as failure. Prose every
        // turn after the first (including the terminal-salvage continuation) so it
        // never submits.
        const provider = scriptedProvider((callIndex) =>
            callIndex === 0
                ? makeMessage(
                      [
                          toolUseBlock("w1", "write_file", {
                              path: "report.html.j2",
                              content: "{% block body %}hi{% endblock %}",
                          }),
                      ],
                      "tool_use",
                  )
                : makeMessage([textBlock("I'm done")], "end_turn"),
        );

        const session = makeSession({
            scope: { kind: "analysis", analysisId: resourceId },
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        });

        const events: Array<{ type: string }> = [];
        const result = await runReportIteration(
            {
                provider,
                pool: NO_POOL,
                model: "anthropic/test",
                templatesDir: "/templates",
                skillsDir: "/skills",
                chrome: {},
            },
            {
                resourceId,
                workspaceRoot,
                previews: stubPreviews(),
                previewId,
                format: "html",
                prompt: "build a v1 report",
                session,
                signal: new AbortController().signal,
                emit: (e) => {
                    events.push(e as { type: string });
                },
            },
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorKind).toBe("submit");
            expect(result.reason).toContain("submit_report");
        }

        // Version dir was rolled back.
        const versionDirAbs = join(workspaceRoot, "previews", previewId, "v1");
        let stillExists = true;
        try {
            await stat(versionDirAbs);
        } catch {
            stillExists = false;
        }
        expect(stillExists).toBe(false);

        // The shared assets/ dir is preserved (not rolled back).
        const assetsDirAbs = join(workspaceRoot, "previews", previewId, "assets");
        const ast = await stat(assetsDirAbs);
        expect(ast.isDirectory()).toBe(true);
    });

    test("explicit baseVersion=0 does not collide with existing v1", async () => {
        const { workspaceRoot, resourceId } = await setupSession();
        const previewId = "prv-collide";

        // Seed an existing v1 with a template and a non-empty index.html.
        const v1Dir = join(workspaceRoot, "previews", previewId, "v1");
        await mkdir(v1Dir, { recursive: true });
        await writeFile(join(v1Dir, "report.html.j2"), "<html><body>v1 template</body></html>", "utf8");
        await writeFile(join(v1Dir, "index.html"), "<html>v1</html>", "utf8");

        // `baseVersion: 0` copies no template in, so the builder authors one.
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("t1", "write_file", {
                        path: "report.html.j2",
                        content: "<html><body>stub template</body></html>",
                    }),
                    toolUseBlock("w1", "write_file", {
                        path: "index.html",
                        content: "<html><body>v2</body></html>",
                    }),
                ],
                "tool_use",
            ),
            makeMessage([toolUseBlock("s1", "submit_report", { notes: [] })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const session = makeSession({
            scope: { kind: "analysis", analysisId: resourceId },
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        });

        const result = await runReportIteration(
            {
                provider,
                pool: NO_POOL,
                model: "anthropic/test",
                templatesDir: "/templates",
                skillsDir: "/skills",
                chrome: {},
            },
            {
                resourceId,
                workspaceRoot,
                previews: stubPreviews(),
                previewId,
                baseVersion: 0,
                format: "html",
                prompt: "build a new version",
                session,
                signal: new AbortController().signal,
                emit: () => {},
            },
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.version).toBe(2);

        // The seeded v1/index.html was NOT overwritten.
        const v1Content = await readFile(join(v1Dir, "index.html"), "utf8");
        expect(v1Content).toBe("<html>v1</html>");
    });

    test("terminal submit stops the agent before post-submit mutations", async () => {
        const { workspaceRoot, resourceId } = await setupSession();
        const previewId = "prv-phantom";

        // The terminal submit must stop the loop before any later tool call can
        // mutate the submitted version.
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("t1", "write_file", {
                        path: "report.html.j2",
                        content: "<html><body>stub template</body></html>",
                    }),
                    toolUseBlock("w1", "write_file", {
                        path: "index.html",
                        content: "<html><body>seed</body></html>",
                    }),
                ],
                "tool_use",
            ),
            makeMessage([toolUseBlock("s1", "submit_report", { notes: [] })], "tool_use"),
        ]);

        const session = makeSession({
            scope: { kind: "analysis", analysisId: resourceId },
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        });

        const result = await runReportIteration(
            {
                provider,
                pool: NO_POOL,
                model: "anthropic/test",
                templatesDir: "/templates",
                skillsDir: "/skills",
                chrome: {},
            },
            {
                resourceId,
                workspaceRoot,
                previews: stubPreviews(),
                previewId,
                format: "html",
                prompt: "build a v1 report",
                session,
                signal: new AbortController().signal,
                emit: () => {},
            },
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.version).toBe(1);
    });
});
