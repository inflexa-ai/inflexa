import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import type { EmbeddingProvider } from "../../../providers/types.js";
import type { PlanRowQuerier } from "../../../state/plans.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { showFileTool } from "../show-file.js";
import { parseUnknownRecord } from "../../../lib/unknown-containers.js";
import { createShowPlanTool } from "../show-plan.js";
import { showUserTool } from "../../display/show-user.js";
import { createWorkspaceSearchTool, type WorkspaceSearchQuerier } from "../workspace-search.js";
import { presentAt } from "../../../lib/present.js";

/** The emitted chat event, checked: the type string and the data record, or a failed test. */
function emittedEvent(emitted: unknown[]): { type: string; data: Record<string, unknown> } {
    const event = parseUnknownRecord(emitted[0]);
    if (event === undefined) throw new Error("the tool emitted no event");
    const data = parseUnknownRecord(event.data);
    if (data === undefined) throw new Error("the event carries no data record");
    if (typeof event.type !== "string") throw new Error("the event carries no type string");
    return { type: event.type, data };
}

/** The record a payload field holds, or a failed test. */
function recordOf(value: unknown): Record<string, unknown> {
    const parsed = parseUnknownRecord(value);
    if (parsed === undefined) throw new Error("the payload field holds no record");
    return parsed;
}

const fakeEmbedding: EmbeddingProvider = {
    dimensions: 3,
    embed: (texts) => okAsync(texts.map(() => [0.1, 0.2, 0.3])),
};

describe("createWorkspaceSearchTool (dependency-bearing factory)", () => {
    it("ranks results from the injected pool + embedding", async () => {
        const fakePool: WorkspaceSearchQuerier = {
            query: async () => ({
                rows: [
                    { id: "v1", score: 0.92, metadata: { path: "out/a.csv", type: "output" } },
                    { id: "v2", score: 0.71, metadata: { path: "out/b.csv", type: "output" } },
                ],
                rowCount: 2,
            }),
        };

        const tool = createWorkspaceSearchTool(fakePool, fakeEmbedding);
        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "differential expression results", limit: 8 }, ctx))._unsafeUnwrap();

        expect(result.results).toHaveLength(2);
        expect(presentAt(result.results, 0).id).toBe("v1");
        expect(presentAt(result.results, 0).score).toBeGreaterThan(presentAt(result.results, 1).score);
    });

    it("returns an empty list when the index table does not exist yet", async () => {
        const fakePool: WorkspaceSearchQuerier = {
            query: async () => {
                throw Object.assign(new Error('relation "search_x" does not exist'), {
                    code: "42P01",
                });
            },
        };

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
        const event = emittedEvent(emitted);
        expect(event.type).toBe("data-presentation");
        expect(event.data.id).toBe(shownId(result));
        expect(event.data.title).toBe("Findings");
        expect(recordOf(event.data.content).kind).toBe("markdown");
        expect(recordOf(event.data.content).body).toBe("## Hello");
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
        const event = emittedEvent(a.emitted);
        expect(recordOf(recordOf(event.data.content)).dataPath).toBe(base.dataPath);
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
        );

        const spec = recordOf(recordOf(emittedEvent(emitted).data.content).spec);
        expect("title" in spec).toBe(false);
        expect(recordOf(spec.xAxis).axisLabel).toEqual({ interval: 0, rotate: 90 });
        expect(recordOf(spec.grid).bottom).toBe("25%");
        expect(spec.toolbox).toEqual({ right: 0, top: 0, feature: { saveAsImage: { type: "png", name: "top-variable-genes" } } });
    });
});

describe("showFile", () => {
    it("emits a data-file-reference event and derives runId from the path", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showFileTool.execute({ files: [{ path: "runs/run-abc/step-1/figures/volcano.png" }] }, ctx))._unsafeUnwrap();

        expect(result.shown).toBe(true);
        const event = emittedEvent(emitted);
        expect(event.type).toBe("data-file-reference");
        const files = event.data.files;
        if (!Array.isArray(files)) throw new Error("the file-reference event carries the files");
        const first = parseUnknownRecord(files[0]);
        if (first === undefined) throw new Error("the files carry the shown entry");
        expect(first.runId).toBe("run-abc");
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
        const fakePool: PlanRowQuerier = {
            query: async () => ({ rows: [], rowCount: 0 }),
        };

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

    function poolWithPlanRow(parentPlanId: string | null): PlanRowQuerier {
        return {
            query: async () => ({
                rows: [{ plan: storedPlan, parent_plan_id: parentPlanId, created_at: "2026-10-02T00:00:00.000Z", superseded_by: null }],
                rowCount: 1,
            }),
        };
    }

    it("emits the parentPlanId of a revision", async () => {
        const tool = createShowPlanTool(poolWithPlanRow("pln-0000000a"));
        const { ctx, emitted } = makeToolContext();
        (await tool.execute({ planId: "pln-0000000b" }, ctx))._unsafeUnwrap();

        const event = emittedEvent(emitted);
        expect(event.type).toBe("data-plan");
        expect(event.data.parentPlanId).toBe("pln-0000000a");
    });

    it("emits no parentPlanId key for a first plan", async () => {
        const tool = createShowPlanTool(poolWithPlanRow(null));
        const { ctx, emitted } = makeToolContext();
        (await tool.execute({ planId: "pln-0000000a" }, ctx))._unsafeUnwrap();

        const event = emittedEvent(emitted);
        expect(event.data).not.toHaveProperty("parentPlanId");
    });
});

describe("showUser — structure", () => {
    const url = "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.pdb";

    it("emits one data-presentation carrying the normalized structure and returns its id", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showUserTool.execute({ kind: "structure", title: "Hemoglobin α", url }, ctx))._unsafeUnwrap();

        expect(emitted).toHaveLength(1);
        const event = emittedEvent(emitted);
        expect(event.type).toBe("data-presentation");
        expect(event.data.id).toBe(shownId(result));
        expect(event.data.content).toEqual({ kind: "structure", format: "pdb", url, provider: "alphafold", accession: "P69905", version: 6 });
    });

    it("reports a URL outside the grammar as invalid_source and emits nothing", async () => {
        const { ctx, emitted } = makeToolContext();
        const result = (await showUserTool.execute({ kind: "structure", url: "https://files.rcsb.org/download/1YCR.cif" }, ctx))._unsafeUnwrap();

        expect(result).toEqual({ shown: false, reason: "invalid_source" });
        expect(emitted).toHaveLength(0);
    });
});
