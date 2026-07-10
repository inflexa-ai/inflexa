import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import type { Pool } from "pg";

import { createIterateReportTool, iterateReportInputSchema, stagedAssetsBlock } from "./iterate-report.js";
import type { ChatProvider } from "../providers/types.js";
import { UnavailablePreviewPublisher } from "./report/preview-publisher.js";

describe("iterateReportInputSchema", () => {
    test("rejects when neither report nor modifications is provided", () => {
        const result = iterateReportInputSchema.safeParse({ format: "html" });
        expect(result.success).toBe(false);
    });

    test("rejects when both report and modifications are provided", () => {
        const result = iterateReportInputSchema.safeParse({
            format: "html",
            report: {
                title: "T",
                audience: "A",
                sources: [],
                sections: [
                    {
                        type: "narrative",
                        title: "Intro",
                        intent: "Test",
                        content: { prose: "hello" },
                    },
                ],
            },
            modifications: "tweak it",
        });
        expect(result.success).toBe(false);
    });

    test("accepts a v1 creation payload (report only, no previewId)", () => {
        const result = iterateReportInputSchema.safeParse({
            format: "html",
            report: {
                title: "Hello",
                audience: "Analysts",
                sources: [],
                sections: [
                    {
                        type: "narrative",
                        title: "Intro",
                        intent: "Hero",
                        content: { prose: "Welcome." },
                    },
                ],
            },
        });
        expect(result.success).toBe(true);
    });

    test("accepts a v2+ iteration payload (modifications + previewId)", () => {
        const result = iterateReportInputSchema.safeParse({
            previewId: "prv-abc12345",
            modifications: "Add a chart for the QC metrics.",
        });
        expect(result.success).toBe(true);
    });

    test("rejects creation with a top-level sources array", () => {
        const result = iterateReportInputSchema.safeParse({
            report: {
                title: "T",
                audience: "A",
                sources: [],
                sections: [
                    {
                        type: "narrative",
                        title: "Intro",
                        intent: "Test",
                        content: { prose: "hi" },
                    },
                ],
            },
            sources: [{ path: "runs/r/output/x.csv" }],
        });
        expect(result.success).toBe(false);
    });

    test("rejects previewId containing path traversal segments", () => {
        const result = iterateReportInputSchema.safeParse({
            previewId: "../../../etc/passwd",
            modifications: "tweak it",
        });
        expect(result.success).toBe(false);
    });

    test("rejects previewId with slashes or uppercase or non-ASCII", () => {
        for (const bad of ["prv/abc", "prv-ABC", "prv abc", "prv-é"]) {
            const result = iterateReportInputSchema.safeParse({
                previewId: bad,
                modifications: "tweak it",
            });
            expect(result.success).toBe(false);
        }
    });

    test("rejects baseVersion of 0", () => {
        const result = iterateReportInputSchema.safeParse({
            previewId: "prv-abc12345",
            baseVersion: 0,
            modifications: "tweak it",
        });
        expect(result.success).toBe(false);
    });

    test("rejects a chart section with both dataAsset and inline data", () => {
        const result = iterateReportInputSchema.safeParse({
            report: {
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
                            data: {
                                columns: ["a"],
                                rows: [{ a: 1 }],
                                source: "from x.csv",
                            },
                            chartType: "bar",
                            encoding: { x: "a" },
                        },
                    },
                ],
            },
        });
        expect(result.success).toBe(false);
    });
});

describe("createIterateReportTool factory", () => {
    test("returns a tool with the expected id and JSON-schema object shape", () => {
        const tool = createIterateReportTool({
            provider: {} as ChatProvider,
            pool: {} as Pool,
            resolveWorkspaceRoot: (id: string) => join("/sessions", id),
            model: "anthropic/claude-opus-4-7",
            templatesDir: "/templates",
            chrome: {},
            createPreviewPublisher: async () => new UnavailablePreviewPublisher(),
        });
        expect(tool.id).toBe("iterate_report");
        expect(typeof tool.description).toBe("string");
        expect((tool.jsonSchema as { type?: unknown }).type).toBe("object");
    });
});

describe("stagedAssetsBlock", () => {
    test("renders the no-assets fallback when staged is empty", () => {
        const out = stagedAssetsBlock([]);
        expect(out).toContain("Staged Assets");
        expect(out).toContain("No file assets");
    });

    test("escapes pipe characters in CSV head rows", () => {
        const out = stagedAssetsBlock([
            {
                name: "data.csv",
                path: "runs/r/output/data.csv",
                kind: "csv",
                sizeBytes: 100,
                columns: ["a", "b|c"],
                headRows: [["1", "two|three"]],
            },
        ]);
        expect(out).toContain("b\\|c");
        expect(out).toContain("two\\|three");
    });
});
