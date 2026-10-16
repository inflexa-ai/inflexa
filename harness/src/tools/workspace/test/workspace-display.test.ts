import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import { z } from "zod";
import type { Pool } from "pg";

import type { EmbeddingProvider } from "../../../providers/types.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { dataPartOf } from "../../__fixtures__/tool-context.js";
import { showFileTool } from "../show-file.js";
import { createShowPlanTool } from "../show-plan.js";
import { showUserTool } from "../../display/show-user.js";
import { createWorkspaceSearchTool } from "../workspace-search.js";
import { optionMember } from "../../../report-render/option-lens.js";
import { poolDouble } from "../../../lib/test/doubles.js";

const fakeEmbedding: EmbeddingProvider = {
    dimensions: 3,
    embed: (texts) => okAsync(texts.map(() => [0.1, 0.2, 0.3])),
};

describe("createWorkspaceSearchTool (dependency-bearing factory)", () => {
    it("ranks results from the injected pool + embedding", async () => {
        // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
        const fakePool = poolDouble(() =>
            Promise.resolve({
                rows: [
                    { id: "v1", score: 0.92, metadata: { path: "out/a.csv", type: "output" } },
                    { id: "v2", score: 0.71, metadata: { path: "out/b.csv", type: "output" } },
                ],
            }),
        );

        const tool = createWorkspaceSearchTool(fakePool, fakeEmbedding);
        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "differential expression results", limit: 8 }, ctx))._unsafeUnwrap();

        expect(result.results).toHaveLength(2);
        expect(result.results[0].id).toBe("v1");
        expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
    });

    it("returns an empty list when the index table does not exist yet", async () => {
        // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
        const fakePool = poolDouble(() =>
            Promise.reject(
                Object.assign(new Error('relation "search_x" does not exist'), {
                    code: "42P01",
                }),
            ),
        );

        const tool = createWorkspaceSearchTool(fakePool, fakeEmbedding);
        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "anything", limit: 8 }, ctx))._unsafeUnwrap();
        expect(result.results).toEqual([]);
    });
});

/** Narrows a `show_user` result to the shown variant, failing the test otherwise. */
function shownId(result: { shown: false; reason: string } | { id: string }): string {
    if (!("id" in result)) throw new Error(`show_user returned invalid_path: ${result.reason}`);
    return result.id;
}

describe("showUser", () => {
    it("emits a data-presentation event with the content payload", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showUserTool.execute({ kind: "markdown", title: "Findings", body: "## Hello" }, ctx))._unsafeUnwrap();

        expect(emitted).toHaveLength(1);
        const part = dataPartOf(emitted[0]);
        expect(part.type).toBe("data-presentation");
        const data = z
            .looseObject({
                id: z.string(),
                title: z.string().optional(),
                content: z.looseObject({ kind: z.string(), body: z.string().optional() }),
            })
            .parse(part.data);
        expect(data.id).toBe(shownId(result));
        expect(data.title).toBe("Findings");
        expect(data.content.kind).toBe("markdown");
        expect(data.content.body).toBe("## Hello");
    });

    it("derives a stable id — identical content emits the same id", async () => {
        const a = makeToolContext();
        const b = makeToolContext();
        const r1 = (await showUserTool.execute({ kind: "code", code: "x <- 1" }, a.ctx))._unsafeUnwrap();
        const r2 = (await showUserTool.execute({ kind: "code", code: "x <- 1" }, b.ctx))._unsafeUnwrap();
        expect(shownId(r1)).toBe(shownId(r2));
    });

    it("carries dataPath into the deterministic id — identical input matches, differing dataPath differs", async () => {
        const base = {
            kind: "echart" as const,
            title: "DE genes",
            spec: { series: [{ type: "scatter" }] },
            dataPath: "runs/run-abc/step-2/output/de-summary.csv",
        };
        const a = makeToolContext();
        const b = makeToolContext();
        const c = makeToolContext();
        const r1 = (await showUserTool.execute(base, a.ctx))._unsafeUnwrap();
        const r2 = (await showUserTool.execute(base, b.ctx))._unsafeUnwrap();
        const r3 = (await showUserTool.execute({ ...base, dataPath: "runs/run-abc/step-2/output/other.csv" }, c.ctx))._unsafeUnwrap();

        expect(shownId(r1)).toBe(shownId(r2));
        expect(shownId(r1)).not.toBe(shownId(r3));
        // The emitted card content carries the dataPath reference.
        const data = z
            .looseObject({ content: z.looseObject({ dataPath: z.string().optional() }) })
            .parse(dataPartOf(a.emitted[0]).data).content;
        expect(data.dataPath).toBe(base.dataPath);
    });

    it("returns the invalid_path variant for a traversal dataPath and does not emit", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showUserTool.execute({ kind: "echart", spec: {}, dataPath: "../outside.csv" }, ctx))._unsafeUnwrap();

        expect("id" in result).toBe(false);
        if (!("id" in result)) expect(result.reason).toBe("invalid_path");
        expect(emitted).toHaveLength(0);
    });

    it("emits an echart whose spec is layout-normalized (the renderer owns the layout, not the model)", async () => {
        const { ctx, emitted } = makeToolContext();
        (
            await showUserTool.execute(
                {
                    kind: "echart",
                    title: "Top Variable Genes",
                    spec: {
                        title: { text: "Top Variable Genes" },
                        xAxis: { type: "category", data: Array.from({ length: 24 }, (_, i) => `gene-${i}`) },
                        yAxis: { type: "value" },
                        series: [{ type: "bar", name: "vst" }],
                    },
                },
                ctx,
            )
        )._unsafeUnwrap();

        const data = z
            .looseObject({ content: z.looseObject({ spec: z.record(z.string(), z.json()) }) })
            .parse(dataPartOf(emitted[0]).data).content;
        const spec = data.spec;
        expect("title" in spec).toBe(false);
        expect(optionMember(spec.xAxis).axisLabel).toEqual({ interval: 0, rotate: 90 });
        expect(optionMember(spec.grid).bottom).toBe("25%");
        expect(spec.toolbox).toEqual({ right: 0, top: 0, feature: { saveAsImage: { type: "png", name: "top-variable-genes" } } });
    });
});

describe("showFile", () => {
    it("emits a data-file-reference event and derives runId from the path", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showFileTool.execute({ files: [{ path: "runs/run-abc/step-1/figures/volcano.png" }] }, ctx))._unsafeUnwrap();

        expect(result.shown).toBe(true);
        const part = dataPartOf(emitted[0]);
        expect(part.type).toBe("data-file-reference");
        const data = z
            .looseObject({ files: z.array(z.looseObject({ path: z.string(), runId: z.string().optional() })) })
            .parse(part.data);
        expect(data.files[0]?.runId).toBe("run-abc");
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
        // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
        const fakePool = poolDouble(() => Promise.resolve({ rows: [] }));

        const tool = createShowPlanTool(fakePool);
        const { ctx, emitted } = makeToolContext();
        const result = (await tool.execute({ planId: "pln-0a1b2c3d" }, ctx))._unsafeUnwrap();

        expect(result.shown).toBe(false);
        if (!result.shown) expect(result.reason).toBe("plan_not_found");
        expect(emitted).toHaveLength(0);
    });

    const storedPlan = {
        title: "Revision",
        analytical_narrative: "why",
        created_at: "2026-10-01T00:00:00.000Z",
        steps: [],
    };

    function poolWithPlanRow(parentPlanId: string | null): Pool {
        return poolDouble(() =>
            Promise.resolve({
                rows: [{ plan: storedPlan, parent_plan_id: parentPlanId, created_at: "2026-10-02T00:00:00.000Z", superseded_by: null }],
            }),
        );
    }

    it("emits the parentPlanId of a revision", async () => {
        const tool = createShowPlanTool(poolWithPlanRow("pln-0000000a"));
        const { ctx, emitted } = makeToolContext();
        (await tool.execute({ planId: "pln-0000000b" }, ctx))._unsafeUnwrap();

        const part = dataPartOf(emitted[0]);
        expect(part.type).toBe("data-plan");
        const data = z.looseObject({ parentPlanId: z.string() }).parse(part.data);
        expect(data.parentPlanId).toBe("pln-0000000a");
    });

    it("emits no parentPlanId key for a first plan", async () => {
        const tool = createShowPlanTool(poolWithPlanRow(null));
        const { ctx, emitted } = makeToolContext();
        (await tool.execute({ planId: "pln-0000000a" }, ctx))._unsafeUnwrap();

        expect(dataPartOf(emitted[0]).type).toBe("data-plan");
        expect(dataPartOf(emitted[0]).data).not.toHaveProperty("parentPlanId");
    });
});

describe("showUser — structure", () => {
    const url = "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.pdb";

    it("emits one data-presentation carrying the normalized structure and returns its id", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showUserTool.execute({ kind: "structure", title: "Hemoglobin α", url }, ctx))._unsafeUnwrap();

        expect(emitted).toHaveLength(1);
        const part = dataPartOf(emitted[0]);
        expect(part.type).toBe("data-presentation");
        const data = z.looseObject({ id: z.string(), content: z.record(z.string(), z.json()) }).parse(part.data);
        expect(data.id).toBe(shownId(result));
        expect(data.content).toEqual({ kind: "structure", format: "pdb", url, provider: "alphafold", accession: "P69905", version: 6 });
    });

    it("reports a URL outside the grammar as invalid_source and emits nothing", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showUserTool.execute({ kind: "structure", url: "https://files.rcsb.org/download/1YCR.cif" }, ctx))._unsafeUnwrap();

        expect(result).toEqual({ shown: false, reason: "invalid_source" });
        expect(emitted).toHaveLength(0);
    });
});
