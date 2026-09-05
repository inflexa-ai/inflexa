import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createWorkspaceMutator } from "../workspace/mutator.js";
import { stepWritePrefix } from "../../workspace/paths.js";
import { fakeKnowledgeClient, renderAnswer, SNAPSHOT } from "./__fixtures__/fake-client.js";
import { CHECK_CALL_LIMIT, createKnowledgeCheckTool } from "./check.js";
import { createKnowledgeTools } from "./index.js";
import { createKnowledgeRecommendTool } from "./recommend.js";
import { DECISION_RECORD_PATH, createKnowledgeTemplateTool } from "./template.js";

const SITUATION = {
    question: "differential_expression" as const,
    modality: "bulk_rna_seq" as const,
    data_state: "counts" as const,
    organism: "human" as const,
    n_groups: 2,
    n_per_group_min: 6,
    n_per_group_max: 6,
    paired: false,
    batch: "none" as const,
};

describe("createKnowledgeTools", () => {
    it("attaches nothing without a client, and the two planner tools with one", () => {
        expect(createKnowledgeTools({})).toEqual([]);
        const { client } = fakeKnowledgeClient();
        expect(createKnowledgeTools({ client }).map((tool) => tool.id)).toEqual(["knowledge_recommend", "knowledge_check"]);
    });

    it("emits flat object schemas that model tool calling accepts", () => {
        const { client } = fakeKnowledgeClient();
        for (const tool of createKnowledgeTools({ client })) {
            expect(tool.jsonSchema.type).toBe("object");
        }
    });
});

describe("knowledge_recommend", () => {
    it("sends the situation with absent optional fields omitted and returns the procedure", async () => {
        const { client, calls } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        expect(out.match).toBe("applicable");
        if (out.match !== "applicable") return;
        expect(out.snapshot.digest).toBe(SNAPSHOT.digest);
        expect(out.procedure.map((step) => step.template)).toContain("tpl-deseq2-two-group@1.0.0");
        expect(calls.recommend[0]?.situation).toEqual(SITUATION);
        expect(Object.keys(calls.recommend[0]!.situation)).not.toContain("covariates");
    });

    it("sends the preferred language beside the situation, not inside it", async () => {
        const { client, calls } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        await tool.execute(tool.inputSchema.parse({ ...SITUATION, preferred_language: "python" }), ctx);
        expect(calls.recommend[0]?.preferences).toEqual({ language: "python" });
        expect(Object.keys(calls.recommend[0]!.situation)).not.toContain("preferred_language");
    });

    it("passes an unavailable answer through as data, never as an error", async () => {
        const { client } = fakeKnowledgeClient({ recommend: { match: "unavailable", reason: "Request timed out after 30000ms" } });
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        expect(out).toEqual({ match: "unavailable", reason: "Request timed out after 30000ms" });
    });

    it("describes the call and the result in one line each", () => {
        const { client } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        expect(tool.describeCall?.(tool.inputSchema.parse(SITUATION))).toBe("differential_expression: 6-6 per group, batch none");
        expect(tool.describeResult?.(tool.inputSchema.parse(SITUATION), { match: "unavailable", reason: "x" })).toBe("unavailable");
    });
});

describe("knowledge_recommend — the environment and the skeleton", () => {
    let base: string;
    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), "kt-env-"));
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });

    it("joins the farm lock and the reference store into each step, and folds the procedure into a plan skeleton", async () => {
        const lockPath = join(base, "inflexa.lock");
        await Bun.write(
            lockPath,
            JSON.stringify({
                schema: 1,
                arch: "arm64",
                languages: {},
                merge_conflicts: [],
                packages: [{ name: "DESeq2", version: "1.52.0", track: "bioconductor", store_dir: "x", hash: "y", requested: true }],
            }),
        );
        const store = join(base, "refs");
        await Bun.write(join(store, "managed", "msigdb-hallmark-human", "2026.1", "h.all.v2026.1.Hs.symbols.gmt"), "HALLMARK_X\tna\tA\tB\n");
        const { client } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client, farmLockFile: lockPath, refStorePath: store });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        const de = out.procedure.find((step) => step.step === "differential_expression")!;
        expect(de.environment?.package).toEqual({ name: "DESeq2", present: true, version: "1.52.0" });
        const enrichment = out.procedure.find((step) => step.step === "enrichment")!;
        expect(enrichment.environment?.package).toEqual({ name: "fgsea", present: false });
        expect(enrichment.environment?.collection?.present).toBe(true);
        expect(enrichment.environment?.collection?.path).toContain("msigdb-hallmark-human");
        expect(out.environment_source).toEqual({ farm: "lock", references: "store" });

        const skeleton = out.plan_skeleton!;
        expect(skeleton.map((step) => step.id)).toEqual(["T1S1", "T1S2", "T2S1"]);
        const analysis = skeleton[1]!;
        expect(analysis.agent).toBe("bulk-transcriptomics-agent");
        expect(analysis.packages).toEqual(["DESeq2"]);
        expect(analysis.depends_on).toEqual(["T1S1"]);
        expect(analysis.constraints).toEqual(["differential_expression: alpha = 0.05 (doi:10.1186/s13059-014-0550-8)"]);
        expect(analysis.grounding).toEqual({
            status: "grounded",
            snapshot: SNAPSHOT.digest,
            claims: ["R-0001@e7d0"],
            template: "tpl-deseq2-two-group@1.0.0",
            reason: "DESeq2 Wald test with apeglm log fold change shrinkage per R-0001@e7d0",
        });
        const gsea = skeleton[2]!;
        expect(gsea.agent).toBe("enrichment-agent");
        expect(gsea.depends_on).toEqual(["T1S2"]);
        expect(gsea.caveats).toEqual(["Few DE genes: ORA has no power."]);
    });

    it("carries no environment when no store is bound, and still folds the skeleton", async () => {
        const { client } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        expect(out.procedure.every((step) => step.environment === undefined)).toBe(true);
        expect(out.environment_source).toEqual({ farm: "unknown", references: "unknown" });
        expect(out.plan_skeleton?.length).toBe(3);
    });
});

describe("knowledge_check", () => {
    it("sends the situation and the drafted steps and returns the findings", async () => {
        const { client, calls } = fakeKnowledgeClient({
            check: {
                ok: false,
                snapshot: SNAPSHOT,
                violations: [{ step_type: "differential_expression", severity: "violation", rule: "R-0004@aaaa", message: "forbidden", permitted: ["limma"] }],
                warnings: [],
            },
        });
        const tool = createKnowledgeCheckTool({ client });
        const { ctx } = makeToolContext();
        const input = tool.inputSchema.parse({ ...SITUATION, steps: [{ step_type: "differential_expression", method: "DESeq2 Wald", package: "DESeq2" }] });
        const out = (await tool.execute(input, ctx))._unsafeUnwrap();
        expect("ok" in out && out.ok).toBe(false);
        expect(calls.check[0]?.steps).toEqual([{ step_type: "differential_expression", method: "DESeq2 Wald", package: "DESeq2" }]);
        expect(calls.check[0]?.situation).toEqual(SITUATION);
        expect(tool.describeResult?.(input, out)).toBe("1 violation(s), 0 warning(s)");
    });

    it("passes a stated outcome through to the service", async () => {
        const { client, calls } = fakeKnowledgeClient({ check: { ok: true, snapshot: SNAPSHOT, violations: [], warnings: [] } });
        const tool = createKnowledgeCheckTool({ client });
        const { ctx } = makeToolContext();
        const input = tool.inputSchema.parse({
            ...SITUATION,
            steps: [{ step_type: "differential_expression", method: "log2 fold change only", outcome: "descriptive_only" }],
        });
        await tool.execute(input, ctx);
        expect(calls.check[0]?.steps[0]?.outcome).toBe("descriptive_only");
    });

    it("refuses the check past the per-plan limit without a call to the service", async () => {
        const { client, calls } = fakeKnowledgeClient({ check: { ok: true, snapshot: SNAPSHOT, violations: [], warnings: [] } });
        const tool = createKnowledgeCheckTool({ client });
        const { ctx } = makeToolContext();
        const input = tool.inputSchema.parse({ ...SITUATION, steps: [{ step_type: "differential_expression", method: "DESeq2 Wald", package: "DESeq2" }] });
        for (let call = 0; call < CHECK_CALL_LIMIT; call += 1) expect("ok" in (await tool.execute(input, ctx))._unsafeUnwrap()).toBe(true);
        const refused = (await tool.execute(input, ctx))._unsafeUnwrap();
        expect(refused).toMatchObject({ match: "rejected", issues: [] });
        expect("message" in refused && refused.message).toContain(`${CHECK_CALL_LIMIT} checks per plan`);
        expect(calls.check).toHaveLength(CHECK_CALL_LIMIT);
        expect(tool.describeResult?.(input, refused)).toBe("rejected");
    });
});

describe("knowledge_template", () => {
    const ANALYSIS = "analysis-001";
    let base: string;
    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), "kt-test-"));
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });

    function build(answers: Parameters<typeof fakeKnowledgeClient>[0] = {}) {
        const workspaceRoot = join(base, ANALYSIS);
        const workingDir = stepWritePrefix({ workspaceRoot, runId: "run-1", stepId: "T1S1" });
        const mutator = createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir });
        const fake = fakeKnowledgeClient(answers);
        return { tool: createKnowledgeTemplateTool({ client: fake.client, mutator }), workingDir, calls: fake.calls };
    }

    it("writes the rendered script and the decision record through the mutator and reports both paths", async () => {
        const { tool, workingDir } = build();
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute({ template: "tpl-deseq2-two-group@1.0.0", slots: { counts_path: "/analysis-001/data/inputs/f1/counts.csv" } }, ctx)
        )._unsafeUnwrap();
        expect(out.status).toBe("ok");
        if (out.status !== "ok") return;
        expect(out.script_path).toBe(`/${ANALYSIS}/runs/run-1/T1S1/scripts/tpl-deseq2-two-group.R`);
        expect(out.decision_record_path).toBe(`/${ANALYSIS}/runs/run-1/T1S1/${DECISION_RECORD_PATH}`);
        expect(out.run_with).toBe("Rscript scripts/tpl-deseq2-two-group.R");
        expect(out.environment_match).toBe("exact");
        const script = await readFile(join(workingDir, "scripts", "tpl-deseq2-two-group.R"), "utf8");
        expect(script).toBe(renderAnswer().script);
        const record = JSON.parse(await readFile(join(workingDir, DECISION_RECORD_PATH), "utf8"));
        expect(record.template).toEqual({ id: "tpl-deseq2-two-group", version: "1.0.0" });
        expect(record.script_path).toBe(out.script_path);
    });

    it("sends the farm versions from the lock when one is given, and none otherwise", async () => {
        const lockPath = join(base, "inflexa.lock");
        await Bun.write(
            lockPath,
            JSON.stringify({
                schema: 1,
                arch: "arm64",
                languages: {},
                merge_conflicts: [],
                packages: [{ name: "DESeq2", version: "1.52.0", track: "bioconductor", store_dir: "x", hash: "y" }],
            }),
        );
        const workspaceRoot = join(base, ANALYSIS);
        const workingDir = stepWritePrefix({ workspaceRoot, runId: "run-1", stepId: "T1S1" });
        const mutator = createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir });
        const fake = fakeKnowledgeClient();
        const tool = createKnowledgeTemplateTool({ client: fake.client, mutator, farmLockFile: lockPath });
        const { ctx } = makeToolContext();
        await tool.execute({ template: "tpl-deseq2-two-group", slots: {} }, ctx);
        const farm = fake.calls.render[0]?.farm;
        // The lock schema may carry more than the two fields; the client sends the pair.
        expect(farm?.some((pkg) => pkg.name === "DESeq2" && pkg.version === "1.52.0") ?? farm === undefined).toBe(true);

        const { tool: bare, calls } = build();
        await bare.execute({ template: "tpl-deseq2-two-group", slots: {} }, ctx);
        expect(calls.render[0]?.farm).toBeUndefined();
    });

    it("returns a rejected answer with the slot and the permitted values as data", async () => {
        const { tool, workingDir } = build({
            render: {
                match: "rejected",
                message: "one or more slot values are not valid",
                issues: [{ slot: "lfc_shrink", reason: "not permitted", permitted: ["apeglm", "ashr", "none"] }],
            },
        });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: "tpl-deseq2-two-group", slots: { lfc_shrink: "x" } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ match: "rejected" });
        expect(await Bun.file(join(workingDir, "scripts", "tpl-deseq2-two-group.R")).exists()).toBe(false);
    });

    it("refuses a script name that escapes scripts/ at the schema", () => {
        const { tool } = build();
        expect(tool.inputSchema.safeParse({ template: "tpl-x", slots: {}, script_name: "../evil.R" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ template: "not-a-template", slots: {} }).success).toBe(false);
    });
});
