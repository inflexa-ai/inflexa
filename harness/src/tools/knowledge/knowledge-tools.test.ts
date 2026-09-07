import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createWorkspaceMutator } from "../workspace/mutator.js";
import { GroundingSchema } from "../../schemas/workflow-state.js";
import { stepWritePrefix } from "../../workspace/paths.js";
import {
    fakeKnowledgeClient,
    limitAnswer,
    notAssessedCheckAnswer,
    recommendAnswer,
    renderAnswer,
    SNAPSHOT,
    substitutionAnswer,
} from "./__fixtures__/fake-client.js";
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
    it("sends the situation with absent optional fields omitted and returns the skeleton", async () => {
        const { client, calls } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        expect(out.match).toBe("applicable");
        if (out.match !== "applicable") return;
        expect(out.snapshot.digest).toBe(SNAPSHOT.digest);
        expect(out.plan_skeleton.map((step) => step.grounding.template)).toContain("tpl-deseq2-two-group@1.0.0");
        expect(calls.recommend[0]?.situation).toEqual(SITUATION);
        expect(Object.keys(calls.recommend[0]!.situation)).not.toContain("covariates");
    });

    it("gives the planner one representation: the skeleton and the claims, never the procedure", async () => {
        const { client } = fakeKnowledgeClient({ recommend: { ...recommendAnswer(), dropped: ["shrink_lfc"], situation: SITUATION } });
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const input = tool.inputSchema.parse(SITUATION);
        const out = (await tool.execute(input, ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        expect(Object.keys(out).sort()).toEqual([
            "claims",
            "dropped",
            "environment_source",
            "flags",
            "match",
            "plan_skeleton",
            "situation",
            "snapshot",
            "uncovered",
        ]);
        expect(JSON.stringify(out)).not.toContain('"procedure"');
        expect(out.dropped).toEqual(["shrink_lfc"]);
        expect(out.situation).toEqual(SITUATION);
        expect(out.claims.map((claim) => claim.id)).toEqual(recommendAnswer().claims.map((claim) => claim.id));
        const cited = new Set(out.plan_skeleton.flatMap((step) => step.grounding.claims));
        for (const id of cited) expect(out.claims.some((claim) => claim.id === id)).toBe(true);
        expect(tool.describeResult?.(input, out)).toBe("3 steps, 6 claims");
    });

    it("keeps the covered skeleton steps of a none answer beside the nearest rules", async () => {
        const [qc] = recommendAnswer().procedure;
        const nearest = [{ claim: "R-0001@e7d0", title: "Replicates", failed: ["n_per_group_min gte 2"] }];
        const { client } = fakeKnowledgeClient({
            recommend: { ...recommendAnswer(), match: "none", procedure: [qc!], claims: [], nearest, reason: "no rule" },
        });
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        if (out.match !== "none") throw new Error(out.match);
        expect(out.plan_skeleton.map((step) => step.id)).toEqual(["T1S1"]);
        expect(out.nearest).toEqual(nearest);
        expect(out.reason).toBe("no rule");
        expect("procedure" in out).toBe(false);
    });

    it("sends the classifier flag and the import state as situation fields, and refuses an unknown import state", async () => {
        const { client, calls } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        await tool.execute(tool.inputSchema.parse({ ...SITUATION, question: "signature_scoring", classifier: true, import_state: "unknown" }), ctx);
        expect(calls.recommend[0]?.situation).toEqual({ ...SITUATION, question: "signature_scoring", classifier: true, import_state: "unknown" });
        expect(tool.inputSchema.safeParse({ ...SITUATION, import_state: "tximport" }).success).toBe(false);
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
        expect(out.environment_source).toEqual({ farm: "lock", references: "store" });

        const skeleton = out.plan_skeleton;
        expect(skeleton.map((step) => step.id)).toEqual(["T1S1", "T1S2", "T2S1"]);
        const analysis = skeleton[1]!;
        expect(analysis.agent).toBe("bulk-transcriptomics-agent");
        expect(analysis.packages).toEqual(["DESeq2"]);
        expect(analysis.depends_on).toEqual(["T1S1"]);
        expect(analysis.environment).toEqual({ package: { name: "DESeq2", present: true, version: "1.52.0" } });
        expect(analysis.constraints).toEqual(["differential_expression: alpha = 0.05 (doi:10.1186/s13059-014-0550-8)"]);
        expect(analysis.alternatives).toEqual([{ method: "M-0003", label: "edgeR quasi-likelihood F-test", when: "robustness", rules: ["R-0001@e7d0"] }]);
        expect(analysis.forbids).toEqual([]);
        expect(analysis.disputed).toBeUndefined();
        expect(analysis.grounding).toEqual({
            status: "grounded",
            snapshot: SNAPSHOT.digest,
            claims: ["R-0001@e7d0", "R-0010@2b3c", "R-0166@4d5e"],
            template: "tpl-deseq2-two-group@1.0.0",
            settings: [{ step: "differential_expression", name: "alpha", value: 0.05, source: "doi:10.1186/s13059-014-0550-8" }],
            reason: "DESeq2 Wald test with apeglm log fold change shrinkage per R-0001@e7d0",
        });
        const gsea = skeleton[2]!;
        expect(gsea.agent).toBe("enrichment-agent");
        expect(gsea.depends_on).toEqual(["T1S2"]);
        expect(gsea.caveats).toEqual(["Few DE genes: ORA has no power."]);
        expect(gsea.environment?.package).toEqual({ name: "fgsea", present: false });
        expect(gsea.environment?.collection?.present).toBe(true);
        expect(gsea.environment?.collection?.path).toContain("msigdb-hallmark-human");
        expect(gsea.grounding.settings).toEqual([{ step: "enrichment", name: "gene_set_collection", value: "msigdb_hallmark_human" }]);
        // The planner copies the grounding as it is, thus each one must validate on the plan schema.
        for (const step of skeleton) expect(GroundingSchema.safeParse(step.grounding).success).toBe(true);
    });

    it("carries the disputed sides, the forbidden methods, and the settings of every folded step on the skeleton step", async () => {
        const base = recommendAnswer();
        const procedure = base.procedure.map((step) =>
            step.step === "differential_expression"
                ? { ...step, forbids: ["M-0002", "M-0004"] }
                : step.step === "multiple_testing"
                  ? {
                        ...step,
                        forbids: ["M-0004"],
                        parameters: [{ name: "adjust_method", value: "BH" }],
                        disputed: { rule: "R-0010@2b3c", sides: ["independent filtering on", "independent filtering off"], choose_and_state: true },
                    }
                  : step,
        );
        const { client } = fakeKnowledgeClient({ recommend: { ...base, procedure } });
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        const analysis = out.plan_skeleton.find((step) => step.id === "T1S2")!;
        expect(analysis.forbids).toEqual(["M-0002", "M-0004"]);
        expect(analysis.disputed).toEqual({ rule: "R-0010@2b3c", sides: ["independent filtering on", "independent filtering off"] });
        expect(analysis.grounding.settings).toEqual([
            { step: "differential_expression", name: "alpha", value: 0.05, source: "doi:10.1186/s13059-014-0550-8" },
            { step: "multiple_testing", name: "adjust_method", value: "BH" },
        ]);
        expect(analysis.constraints).toEqual(["differential_expression: alpha = 0.05 (doi:10.1186/s13059-014-0550-8)", "multiple_testing: adjust_method = BH"]);
    });

    it("renders a parameter conflict as a caveat that names both rules, never as a constraint", async () => {
        const { client } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        const analysis = out.plan_skeleton.find((step) => step.id === "T1S2")!;
        expect(analysis.caveats).toEqual(["multiple_testing: independent_filtering conflicts between R-0010@2b3c and R-0166@4d5e"]);
        expect(analysis.constraints.some((constraint) => constraint.includes("independent_filtering"))).toBe(false);
        expect(analysis.constraints).toEqual(["differential_expression: alpha = 0.05 (doi:10.1186/s13059-014-0550-8)"]);
    });

    it("names the substitute as the step method and renders the substitution as a caveat", async () => {
        const { client } = fakeKnowledgeClient({ recommend: substitutionAnswer() });
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute(
                tool.inputSchema.parse({ ...SITUATION, question: "enrichment", enrichment_input: "sample_scores", preferred_language: "python" }),
                ctx,
            )
        )._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        const enrichment = out.plan_skeleton.find((step) => step.id === "T2S1")!;
        expect(enrichment.name).toBe("decoupler ulm per-sample pathway scores with a two-sample t-test on the scores");
        expect(enrichment.packages).toEqual(["decoupler"]);
        expect(enrichment.grounding.template).toBe("tpl-decoupler-scores@1.0.0");
        expect(enrichment.caveats).toEqual([
            "decoupler ulm per-sample pathway scores with a two-sample t-test on the scores stands in for GSVA per-sample pathway scores with limma on the scores",
        ]);
        expect(enrichment.constraints).toEqual(["enrichment: gene_set_collection = msigdb_hallmark_human"]);
        expect(enrichment.grounding.settings).toEqual([{ step: "enrichment", name: "gene_set_collection", value: "msigdb_hallmark_human" }]);
    });

    it("renders a language limit as a caveat and keeps the named template", async () => {
        const { client } = fakeKnowledgeClient({ recommend: limitAnswer() });
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse({ ...SITUATION, paired: true, preferred_language: "python" }), ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        const analysis = out.plan_skeleton.find((step) => step.id === "T1S2")!;
        expect(analysis.grounding.template).toBe("tpl-deseq2-blocked@1.0.0");
        expect(analysis.packages).toEqual(["DESeq2"]);
        expect(analysis.caveats).toEqual([
            "the requested language has no template that realizes DESeq2 Wald test with apeglm log fold change shrinkage for this design; the R template is named",
        ]);
        expect(analysis.constraints).toEqual([]);
        expect(analysis.grounding.settings).toEqual([]);
    });

    it("carries no environment when no store is bound, and still folds the skeleton", async () => {
        const { client } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        expect(out.plan_skeleton.every((step) => step.environment === undefined)).toBe(true);
        expect(out.environment_source).toEqual({ farm: "unknown", references: "unknown" });
        expect(out.plan_skeleton.length).toBe(3);
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

    it("sends the method id through to the service, and refuses a malformed one at the schema", async () => {
        const { client, calls } = fakeKnowledgeClient();
        const tool = createKnowledgeCheckTool({ client });
        const { ctx } = makeToolContext();
        const input = tool.inputSchema.parse({
            ...SITUATION,
            steps: [{ step_type: "differential_expression", method: "DESeq2 Wald test", method_id: "M-0001" }],
        });
        await tool.execute(input, ctx);
        expect(calls.check[0]?.steps[0]?.method_id).toBe("M-0001");
        expect(
            tool.inputSchema.safeParse({ ...SITUATION, steps: [{ step_type: "differential_expression", method: "DESeq2 Wald test", method_id: "deseq2" }] })
                .success,
        ).toBe(false);
    });

    it("shows the steps the check did not assess beside the findings", async () => {
        const { client } = fakeKnowledgeClient({ check: notAssessedCheckAnswer() });
        const tool = createKnowledgeCheckTool({ client });
        const { ctx } = makeToolContext();
        const input = tool.inputSchema.parse({ ...SITUATION, steps: [{ step_type: "shrink_lfc", method: "apeglm" }] });
        const out = (await tool.execute(input, ctx))._unsafeUnwrap();
        expect("ok" in out && out.ok).toBe(true);
        expect("not_assessed" in out && out.not_assessed).toEqual(notAssessedCheckAnswer().not_assessed);
        expect(tool.describeResult?.(input, out)).toBe("ok, 1 not assessed");
        expect(
            tool.describeResult?.(input, {
                ...notAssessedCheckAnswer(),
                ok: false,
                violations: [{ step_type: "differential_expression", severity: "violation", rule: "R-0004@aaaa", message: "forbidden" }],
            }),
        ).toBe("1 violation(s), 0 warning(s), 1 not assessed");
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
        expect(record.template).toEqual({
            id: "tpl-deseq2-two-group",
            version: "1.0.0",
            label: "DESeq2 two-group",
            method: { id: "M-0001", label: "DESeq2 Wald test with apeglm log fold change shrinkage" },
        });
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
