import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import type { Pool } from "pg";

import type { EmbeddingProvider } from "../../providers/types.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { showFileTool } from "./show-file.js";
import { createShowPlanTool } from "./show-plan.js";
import { showUserTool } from "../display/show-user.js";
import { createWorkspaceSearchTool } from "./workspace-search.js";

const fakeEmbedding: EmbeddingProvider = {
    embed: (texts) => okAsync(texts.map(() => [0.1, 0.2, 0.3])),
};

describe("createWorkspaceSearchTool (dependency-bearing factory)", () => {
    it("ranks results from the injected pool + embedding", async () => {
        const fakePool = {
            query: async () => ({
                rows: [
                    { id: "v1", score: 0.92, metadata: { path: "out/a.csv", type: "output" } },
                    { id: "v2", score: 0.71, metadata: { path: "out/b.csv", type: "output" } },
                ],
            }),
        } as unknown as Pool;

        const tool = createWorkspaceSearchTool(fakePool, fakeEmbedding);
        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "differential expression results", limit: 8 }, ctx))._unsafeUnwrap();

        expect(result.results).toHaveLength(2);
        expect(result.results[0]!.id).toBe("v1");
        expect(result.results[0]!.score).toBeGreaterThan(result.results[1]!.score);
    });

    it("returns an empty list when the index table does not exist yet", async () => {
        const fakePool = {
            query: async () => {
                throw Object.assign(new Error('relation "search_x" does not exist'), {
                    code: "42P01",
                });
            },
        } as unknown as Pool;

        const tool = createWorkspaceSearchTool(fakePool, fakeEmbedding);
        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "anything", limit: 8 }, ctx))._unsafeUnwrap();
        expect(result.results).toEqual([]);
    });
});

describe("showUser", () => {
    it("emits a data-presentation event with the content payload", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showUserTool.execute({ kind: "markdown", title: "Findings", body: "## Hello" }, ctx))._unsafeUnwrap();

        expect(emitted).toHaveLength(1);
        const event = emitted[0] as {
            type: string;
            data: { id: string; title?: string; content: { kind: string; body?: string } };
        };
        expect(event.type).toBe("data-presentation");
        expect(event.data.id).toBe(result.id);
        expect(event.data.title).toBe("Findings");
        expect(event.data.content.kind).toBe("markdown");
        expect(event.data.content.body).toBe("## Hello");
    });

    it("derives a stable id — identical content emits the same id", async () => {
        const a = makeToolContext();
        const b = makeToolContext();
        const r1 = (await showUserTool.execute({ kind: "code", code: "x <- 1" }, a.ctx))._unsafeUnwrap();
        const r2 = (await showUserTool.execute({ kind: "code", code: "x <- 1" }, b.ctx))._unsafeUnwrap();
        expect(r1.id).toBe(r2.id);
    });
});

describe("showFile", () => {
    it("emits a data-file-reference event and derives runId from the path", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showFileTool.execute({ files: [{ path: "runs/run-abc/step-1/figures/volcano.png" }] }, ctx))._unsafeUnwrap();

        expect(result.shown).toBe(true);
        const event = emitted[0] as {
            type: string;
            data: { files: Array<{ path: string; runId?: string }> };
        };
        expect(event.type).toBe("data-file-reference");
        expect(event.data.files[0]!.runId).toBe("run-abc");
    });

    it("returns the invalid_path variant for a traversal path and does not emit", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showFileTool.execute({ files: [{ path: "../../etc/passwd" }] }, ctx))._unsafeUnwrap();

        expect(result.shown).toBe(false);
        if (!result.shown) expect(result.reason).toBe("invalid_path");
        expect(emitted).toHaveLength(0);
    });
});

describe("createShowPlanTool (dependency-bearing factory)", () => {
    it("returns the plan_not_found variant when the plan is absent", async () => {
        const fakePool = {
            query: async () => ({ rows: [] }),
        } as unknown as Pool;

        const tool = createShowPlanTool(fakePool);
        const { ctx, emitted } = makeToolContext();
        const result = (await tool.execute({ planId: "pln-0a1b2c3d" }, ctx))._unsafeUnwrap();

        expect(result.shown).toBe(false);
        if (!result.shown) expect(result.reason).toBe("plan_not_found");
        expect(emitted).toHaveLength(0);
    });
});
