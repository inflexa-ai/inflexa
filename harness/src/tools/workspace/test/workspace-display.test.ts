import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import type { EmbeddingProvider } from "../../../providers/types.js";
import type { PlanRowQuerier } from "../../../state/plans.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { showFileTool } from "../show-file.js";
import { parseUnknownRecord } from "../../../lib/unknown-containers.js";
import { createShowPlanTool } from "../show-plan.js";
import { createReadPlanTool } from "../read-plan.js";
import { showUserTool } from "../../display/show-user.js";
import { createWorkspaceSearchTool, type WorkspaceSearchQuerier } from "../workspace-search.js";
import { presentAt } from "../../../lib/present.js";
import { awaitOk } from "../../../lib/test/result-assert.js";

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
            query: () =>
                Promise.resolve({
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
            query: () => {
                return Promise.reject(
                    Object.assign(new Error('relation "search_x" does not exist'), {
                        code: "42P01",
                    }),
                );
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
        await awaitOk(
            showUserTool.execute(
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
            ),
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
            query: () => Promise.resolve({ rows: [], rowCount: 0 }),
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
            query: () =>
                Promise.resolve({
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

describe("createReadPlanTool (dependency-bearing factory)", () => {
    const setting = { step: "differential_expression", name: "alpha", value: 0.05, source: "doi:10.1186/s13059-014-0550-8" };
    const stepOf = (id: string, claim: string) => ({
        id,
        name: `Step ${id}`,
        description: "Fit the model.",
        question: "Which genes differ?",
        agent: "bulk-transcriptomics-agent",
        depends_on: [],
        status: "pending",
        track: "T1",
        step_type: "analysis",
        acceptance_criteria: [],
        maxSteps: 40,
        grounding: { status: "grounded", snapshot: "sha256:0001", claims: [claim], settings: [setting], reason: "per the rule" },
    });
    const stored = {
        title: "Two fits",
        analytical_narrative: "why",
        created_at: "2026-10-01T00:00:00.000Z",
        steps: [stepOf("T1S1", "R-0001@e7d0"), stepOf("T1S2", "R-0002@6b60")],
        claims: [
            { id: "R-0001@e7d0", snapshot: "sha256:0001", title: "Wald test", strength: "established", statement: "long text", evidence: [] },
            { id: "R-0002@6b60", snapshot: "sha256:0001", title: "Shrinkage", strength: "common_practice", statement: "long text", evidence: [] },
        ],
    };

    function poolWith(plan: unknown): PlanRowQuerier {
        const rows = plan === undefined ? [] : [{ plan, parent_plan_id: "pln-0000000a", created_at: "2026-10-02T00:00:00.000Z", superseded_by: null }];
        return { query: () => Promise.resolve({ rows, rowCount: rows.length }) };
    }

    async function read(plan: unknown, stepIds?: string[]) {
        const { ctx, emitted } = makeToolContext();
        const result = (await createReadPlanTool(poolWith(plan)).execute({ planId: "pln-0000000b", stepIds }, ctx))._unsafeUnwrap();
        expect(emitted).toHaveLength(0);
        return result;
    }

    it("gives the whole plan with no settings, and the title of each claim", async () => {
        const result = await read(stored);

        if (!result.found) throw new Error("the plan was not found");
        expect(result.parentPlanId).toBe("pln-0000000a");
        expect(result.plan.steps.map((step) => step.id)).toEqual(["T1S1", "T1S2"]);
        expect(result.plan.steps.map((step) => step.grounding?.settings)).toEqual([undefined, undefined]);
        expect(result.plan.steps[0]?.grounding?.claims).toEqual(["R-0001@e7d0"]);
        expect(result.plan).not.toHaveProperty("claims");
        expect(result.claims).toEqual([
            { id: "R-0001@e7d0", title: "Wald test", strength: "established" },
            { id: "R-0002@6b60", title: "Shrinkage", strength: "common_practice" },
        ]);
    });

    it("gives only the named steps, each with its settings and the claims that it cites", async () => {
        const result = await read(stored, ["T1S2", "T9S9"]);

        if (!result.found) throw new Error("the plan was not found");
        expect(result.plan.steps.map((step) => step.id)).toEqual(["T1S2"]);
        expect(result.plan.steps[0]?.grounding?.settings).toEqual([setting]);
        expect(result.claims).toEqual([{ id: "R-0002@6b60", title: "Shrinkage", strength: "common_practice" }]);
        expect(result.absentStepIds).toEqual(["T9S9"]);
    });

    it("gives plan_not_found for an absent plan and for a stored plan that does not parse", async () => {
        expect(await read(undefined)).toEqual({ found: false, reason: "plan_not_found" });
        expect(await read({ steps: "none" })).toEqual({ found: false, reason: "plan_not_found" });
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
