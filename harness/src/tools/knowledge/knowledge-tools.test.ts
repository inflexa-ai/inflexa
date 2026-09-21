import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createWorkspaceMutator } from "../workspace/mutator.js";
import { GroundingSchema } from "../../schemas/workflow-state.js";
import { stepWritePrefix } from "../../workspace/paths.js";
import { fakeKnowledgeClient, limitAnswer, notAssessedCheckAnswer, recommendAnswer, SNAPSHOT, substitutionAnswer } from "./__fixtures__/fake-client.js";
import { CHECK_CALL_LIMIT, createKnowledgeCheckTool } from "./check.js";
import { joinEnvironment } from "./environment.js";
import { createKnowledgeTools, knowledgeToolDefinitionHash } from "./index.js";
import { createKnowledgeRecommendTool } from "./recommend.js";
import { buildPlanSkeleton } from "./skeleton.js";
import { decisionRecordPath } from "../workspace/decision-record.js";
import { createKnowledgeTemplateTool } from "./template.js";

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
        expect(out.environment_source).toEqual({ farm: "lock", image: "unknown", references: "store" });

        const skeleton = out.plan_skeleton;
        expect(skeleton.map((step) => step.id)).toEqual(["T1S1", "T1S2", "T2S1"]);
        const analysis = skeleton[1]!;
        expect(analysis.agent).toBe("bulk-transcriptomics-agent");
        expect(analysis.packages).toEqual(["DESeq2"]);
        expect(analysis.depends_on).toEqual(["T1S1"]);
        expect(analysis.environment).toEqual({ package: { name: "DESeq2", present: true, version: "1.52.0" } });
        // A parameter is a setting of the grounding, never a constraint of the step.
        expect("constraints" in analysis).toBe(false);
        expect(analysis.alternatives).toEqual([{ method: "M-0003", label: "Alternative count-model F-test", when: "robustness", rules: ["R-0001@e7d0"] }]);
        expect(analysis.forbids).toEqual([]);
        expect(analysis.disputed).toBeUndefined();
        expect(analysis.grounding).toEqual({
            status: "grounded",
            snapshot: SNAPSHOT.digest,
            claims: ["R-0001@e7d0", "R-0010@2b3c", "R-0166@4d5e"],
            template: "tpl-deseq2-two-group@1.0.0",
            settings: [{ step: "differential_expression", name: "alpha", value: 0.05, source: "doi:10.1186/s13059-014-0550-8" }],
            reason: "Count-model Wald test with effect shrinkage per R-0001@e7d0",
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
    });

    it("renders a parameter conflict as a caveat that names both rules, never as a setting", async () => {
        const { client } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        const analysis = out.plan_skeleton.find((step) => step.id === "T1S2")!;
        expect(analysis.caveats).toEqual(["multiple_testing: independent_filtering conflicts between R-0010@2b3c and R-0166@4d5e"]);
        expect(analysis.grounding.settings.some((setting) => setting.name === "independent_filtering")).toBe(false);
        expect(analysis.grounding.settings).toEqual([{ step: "differential_expression", name: "alpha", value: 0.05, source: "doi:10.1186/s13059-014-0550-8" }]);
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
        expect(enrichment.name).toBe("Per-sample activity scores with a two-sample test");
        expect(enrichment.packages).toEqual(["decoupler"]);
        expect(enrichment.grounding.template).toBe("tpl-decoupler-scores@1.0.0");
        expect(enrichment.caveats).toEqual(["Per-sample activity scores with a two-sample test stands in for Per-sample set scores with a linear model"]);
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
            "the requested language has no template that realizes Count-model Wald test with effect shrinkage for this design; the R template is named",
        ]);
        expect(analysis.grounding.settings).toEqual([]);
    });

    it("carries no environment when no store is bound, and still folds the skeleton", async () => {
        const { client } = fakeKnowledgeClient();
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        expect(out.plan_skeleton.every((step) => step.environment === undefined)).toBe(true);
        expect(out.environment_source).toEqual({ farm: "unknown", image: "unknown", references: "unknown" });
        expect(out.plan_skeleton.length).toBe(3);
    });

    it("grounds a group whose steps carry rules and no method, and leaves a group with neither ungrounded", async () => {
        const base = recommendAnswer();
        const skeletonStepOf = async (recommend: ReturnType<typeof recommendAnswer>, id: string) => {
            const { client } = fakeKnowledgeClient({ recommend });
            const tool = createKnowledgeRecommendTool({ client });
            const { ctx } = makeToolContext();
            const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
            if (out.match !== "applicable") throw new Error(out.match);
            return out.plan_skeleton.find((step) => step.id === id)!;
        };
        // The report step of the service carries the reporting rules and no
        // method: the rules cover it, thus the step is grounded by them.
        const covered = { ...base, procedure: [...base.procedure, { step: "report", rules: ["R-0041@ab41", "R-0086@ab86"] }], uncovered: [] };
        const report = await skeletonStepOf(covered, "T1S3");
        expect(report.grounding.status).toBe("grounded");
        expect(report.grounding.claims).toEqual(["R-0041@ab41", "R-0086@ab86"]);
        expect(report.grounding.reason).toBe("Report per R-0041@ab41");
        expect(report.grounding.template).toBeUndefined();
        // A step with no rule and no method is the one case with no cover.
        const bare = { ...base, procedure: [...base.procedure, { step: "report", rules: [] }], uncovered: [] };
        const uncovered = await skeletonStepOf(bare, "T1S3");
        expect(uncovered.grounding.status).toBe("ungrounded");
        expect(uncovered.grounding.claims).toEqual([]);
        expect(uncovered.grounding.reason).toBe("no rule covers this step");
    });

    it("names the executable gap of a step whose method has no template, and lists the step in unrealized", async () => {
        const base = recommendAnswer();
        const gap = {
            reason: "No template of DESeq2 Wald holds for the differential_expression step in this situation.",
            templates: [{ template: "tpl-deseq2-two-group@1.0.0", why: "the condition n_timepoints is_null does not hold" }],
        };
        const procedure = base.procedure.map((step) => (step.step === "differential_expression" ? { ...step, template: undefined, unrealized: gap } : step));
        const { client } = fakeKnowledgeClient({ recommend: { ...base, procedure, unrealized: ["differential_expression"] } });
        const tool = createKnowledgeRecommendTool({ client });
        const { ctx } = makeToolContext();
        const out = (await tool.execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        if (out.match !== "applicable") throw new Error(out.match);
        expect(out.unrealized).toEqual(["differential_expression"]);
        const analysis = out.plan_skeleton.find((step) => step.id === "T1S2")!;
        // The method and the claims stay: the knowledge covers the step, and the caveat names the absent script.
        expect(analysis.grounding.status).toBe("grounded");
        expect(analysis.grounding.template).toBeUndefined();
        expect(analysis.caveats.some((caveat) => caveat.includes("no vetted template realizes") && caveat.includes("n_timepoints is_null"))).toBe(true);
        // An answer with no gap carries no field.
        const { client: plain } = fakeKnowledgeClient({ recommend: base });
        const plainOut = (await createKnowledgeRecommendTool({ client: plain }).execute(tool.inputSchema.parse(SITUATION), ctx))._unsafeUnwrap();
        expect("unrealized" in plainOut).toBe(false);
    });

    it("folds a cohort assembly step into one group before the QC, and the QC depends on it", () => {
        const answer = recommendAnswer();
        const cohort = {
            step: "cohort_assembly",
            method: { id: "M-0065", label: "Cohort assembly" },
            template: "tpl-cohort-assembly@1.0.0",
            rules: ["R-0194@aa11"],
            parameters: [{ name: "unit_count", value: "counted_per_group_from_the_sample_table_after_the_step", default_source: "rule:R-0194" }],
        };
        const skeleton = buildPlanSkeleton({ ...answer, procedure: [cohort, ...answer.procedure] });
        expect(skeleton.map((step) => step.id)).toEqual(["T0S1", "T1S1", "T1S2", "T2S1"]);
        const assembly = skeleton[0]!;
        expect(assembly.step_type).toBe("data_preparation");
        expect(assembly.agent).toBe("bulk-transcriptomics-agent");
        expect(assembly.depends_on).toEqual([]);
        expect(assembly.grounding.template).toBe("tpl-cohort-assembly@1.0.0");
        expect(assembly.grounding.settings).toEqual([
            { step: "cohort_assembly", name: "unit_count", value: "counted_per_group_from_the_sample_table_after_the_step", source: "rule:R-0194" },
        ]);
        expect(skeleton[1]!.depends_on).toEqual(["T0S1"]);
        expect(skeleton[2]!.depends_on).toEqual(["T1S1"]);
        // Without the step the QC depends on nothing, as before.
        expect(buildPlanSkeleton(answer)[0]!.depends_on).toEqual([]);
    });
});

describe("the release pin of one plan", () => {
    it("the first recommend answer pins the release, and every later call of the two tools carries it", async () => {
        const fake = fakeKnowledgeClient();
        const [recommend, check] = createKnowledgeTools({ client: fake.client });
        const { ctx } = makeToolContext();
        await recommend!.execute(SITUATION, ctx);
        expect(fake.calls.recommend[0]?.expected_snapshot).toBeUndefined();
        await recommend!.execute(SITUATION, ctx);
        expect(fake.calls.recommend[1]?.expected_snapshot).toBe(SNAPSHOT.digest);
        await check!.execute({ ...SITUATION, steps: [{ step_type: "differential_expression", method: "DESeq2 Wald" }] }, ctx);
        expect(fake.calls.check[0]?.expected_snapshot).toBe(SNAPSHOT.digest);
    });

    it("a check before any answer carries no pin, and a mismatch answer passes through as data", async () => {
        const mismatch = { match: "snapshot_mismatch" as const, message: "another release", expected: "sha256:aa", served: SNAPSHOT };
        const fake = fakeKnowledgeClient({ check: mismatch });
        const [, check] = createKnowledgeTools({ client: fake.client });
        const { ctx } = makeToolContext();
        const out = (await check!.execute({ ...SITUATION, steps: [{ step_type: "differential_expression", method: "DESeq2 Wald" }] }, ctx))._unsafeUnwrap();
        expect(fake.calls.check[0]?.expected_snapshot).toBeUndefined();
        expect(out).toEqual(mismatch);
        expect(check!.describeResult?.({ ...SITUATION, steps: [] }, out)).toBe("snapshot_mismatch");
    });

    it("the tool definition hash is stable and names the three tools", () => {
        const first = knowledgeToolDefinitionHash();
        expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(knowledgeToolDefinitionHash()).toBe(first);
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
        expect(out.decision_record_path).toBe(`/${ANALYSIS}/runs/run-1/T1S1/output/decision_record_tpl-deseq2-two-group.json`);
        expect(out.run_with).toBe("Rscript scripts/tpl-deseq2-two-group.R");
        expect(out.environment_match).toBe("exact");
        // The count path is a local slot: the service answered with its marker, and the tool bound the value here.
        const script = await readFile(join(workingDir, "scripts", "tpl-deseq2-two-group.R"), "utf8");
        expect(script).toBe('COUNTS <- "/analysis-001/data/inputs/f1/counts.csv"  # [adaptable: counts_path]\nmessage("hello")\n');
        expect(out.local_slots).toEqual(["counts_path"]);
        expect(out.written_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
        const record = JSON.parse(await readFile(join(workingDir, decisionRecordPath("tpl-deseq2-two-group.R")), "utf8"));
        expect(record.template).toEqual({
            id: "tpl-deseq2-two-group",
            version: "1.0.0",
            label: "Two-group count model",
            method: { id: "M-0001", label: "Count-model Wald test with effect shrinkage" },
        });
        expect(record.script_path).toBe(out.script_path);
        expect(record.written_sha256).toBe(out.written_sha256);
        expect(record.slots).toEqual([
            { name: "counts_path", value: "/analysis-001/data/inputs/f1/counts.csv", source: "caller", adaptable: true, lines: [1] },
        ]);
    });

    it("never sends a local value to the service, with or without a binding", async () => {
        const sentinel = "/analysis-001/data/inputs/SENTINEL-7f3a9c/counts.csv";
        const { tool, calls } = build();
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute(
                { template: "tpl-deseq2-two-group@1.0.0", slots: { counts_path: sentinel, condition_column: "SENTINEL_column", lfc_shrink: "ashr" } },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ok" });
        // Without a binding the tool reads the contract for the local slots, then sends the rest only.
        expect(calls.contract).toEqual([{ template: "tpl-deseq2-two-group@1.0.0" }]);
        expect(calls.render).toHaveLength(1);
        expect(calls.render[0]?.slots).toEqual({ lfc_shrink: "ashr" });
        expect(JSON.stringify(calls)).not.toContain("SENTINEL");
    });

    it("refuses a local value the contract refuses on this machine, before the render and before any write", async () => {
        const { tool, workingDir, calls } = build();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: "tpl-deseq2-two-group@1.0.0", slots: { counts_path: 42 } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ match: "rejected", issues: [{ slot: "counts_path", reason: "a non-empty string is required" }] });
        expect(calls.render).toHaveLength(0);
        expect(await Bun.file(join(workingDir, "scripts", "tpl-deseq2-two-group.R")).exists()).toBe(false);
    });

    it("refuses a column name where the situation takes a role", () => {
        const [recommend] = createKnowledgeTools({ client: fakeKnowledgeClient().client });
        expect(recommend!.inputSchema.safeParse({ ...SITUATION, blocking_factor: "donor_id" }).success).toBe(false);
        expect(
            recommend!.inputSchema.safeParse({ ...SITUATION, blocking_factor: "individual", covariates: ["sex", "clinical"], continuous_predictor: null })
                .success,
        ).toBe(true);
        expect(recommend!.inputSchema.safeParse({ ...SITUATION, covariates: ["age_years"] }).success).toBe(false);
    });

    it("passes a snapshot mismatch through as data, and writes nothing", async () => {
        const mismatch = { match: "snapshot_mismatch" as const, message: "another release", expected: "sha256:aa", served: SNAPSHOT };
        const { tool, workingDir } = build({ render: mismatch });
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute({ template: "tpl-deseq2-two-group@1.0.0", slots: { counts_path: "/analysis-001/data/inputs/f1/counts.csv" } }, ctx)
        )._unsafeUnwrap();
        expect(out).toEqual(mismatch);
        expect(tool.describeResult?.({ template: "tpl-x", slots: {} }, out)).toBe("snapshot_mismatch");
        expect(await Bun.file(join(workingDir, "scripts", "tpl-deseq2-two-group.R")).exists()).toBe(false);
    });

    it("sends the installed versions of both records when the host names them, and none otherwise", async () => {
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
        const recordPath = join(base, "image-packages.json");
        await Bun.write(
            recordPath,
            JSON.stringify({
                schema: 1,
                image: { repository: "ghcr.io/inflexa-ai/sandbox-base", version: "20260917-abc1234", arch: "arm64" },
                runtimes: { python: "3.12.3", r: "4.6.0", node: "24.19.0" },
                system_tools: [],
                node: [],
                r_base: [{ name: "survival", version: "3.8-6", priority: "recommended" }],
            }),
        );
        const workspaceRoot = join(base, ANALYSIS);
        const workingDir = stepWritePrefix({ workspaceRoot, runId: "run-1", stepId: "T1S1" });
        const mutator = createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir });
        const fake = fakeKnowledgeClient();
        const tool = createKnowledgeTemplateTool({ client: fake.client, mutator, farmLockFile: lockPath, imagePackagesFile: recordPath });
        const { ctx } = makeToolContext();
        await tool.execute({ template: "tpl-deseq2-two-group", slots: {} }, ctx);
        const farm = fake.calls.render[0]?.farm;
        // The lock schema may carry more than the two fields; the client sends the pair.
        expect(farm?.some((pkg) => pkg.name === "DESeq2" && pkg.version === "1.52.0")).toBe(true);
        // A template that pins a package of the R runtime matches against the version the image ships.
        expect(farm?.some((pkg) => pkg.name === "survival" && pkg.version === "3.8-6")).toBe(true);

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

describe("joinEnvironment", () => {
    it("reads the packages of the R runtime from the image record, and keeps the farm version of a name both records carry", async () => {
        const base = mkdtempSync(join(tmpdir(), "inflexa-env-"));
        try {
            const lockPath = join(base, "inflexa.lock");
            await Bun.write(
                lockPath,
                JSON.stringify({
                    schema: 1,
                    arch: "arm64",
                    languages: {},
                    merge_conflicts: [],
                    packages: [
                        { name: "survminer", version: "0.5.2", track: "cran", store_dir: "x", hash: "y", requested: true },
                        { name: "Matrix", version: "1.8-0", track: "cran", store_dir: "m", hash: "n", requested: false },
                    ],
                }),
            );
            const recordPath = join(base, "image-packages.json");
            await Bun.write(
                recordPath,
                JSON.stringify({
                    schema: 1,
                    image: { repository: "ghcr.io/inflexa-ai/sandbox-base", version: "20260917-abc1234", arch: "arm64" },
                    runtimes: { python: "3.12.3", r: "4.6.0", node: "24.19.0" },
                    system_tools: [{ name: "samtools", version: "1.22" }],
                    node: [{ name: "echarts", version: "6.1.0" }],
                    r_base: [
                        { name: "survival", version: "3.8-6", priority: "recommended" },
                        { name: "Matrix", version: "1.7-5", priority: "recommended" },
                    ],
                }),
            );
            const answer = {
                match: "applicable" as const,
                snapshot: { date: "2026-09-16", digest: "sha256:abc" },
                procedure: [
                    { step: "survival", rules: [], package: { name: "survival" } },
                    { step: "clustering", rules: [], package: { name: "ConsensusClusterPlus" } },
                    { step: "report", rules: [], package: { name: "survminer" } },
                    { step: "coexpression", rules: [], package: { name: "Matrix" } },
                    // A tool of the image is not of a package track a template pins, thus it answers for no package.
                    { step: "annotation", rules: [], package: { name: "samtools" } },
                ],
                uncovered: [],
                flags: [],
                claims: [],
            };

            const joined = await joinEnvironment(answer, { farmLockFile: lockPath, imagePackagesFile: recordPath });
            expect(joined.environment_source).toEqual({ farm: "lock", image: "record", references: "unknown" });
            expect(joined.procedure[0]?.environment?.package).toEqual({ name: "survival", present: true, version: "3.8-6" });
            expect(joined.procedure[1]?.environment?.package).toEqual({ name: "ConsensusClusterPlus", present: false });
            expect(joined.procedure[2]?.environment?.package).toEqual({ name: "survminer", present: true, version: "0.5.2" });
            // Two records name Matrix, and the farm links the copy a step loads.
            expect(joined.procedure[3]?.environment?.package).toEqual({ name: "Matrix", present: true, version: "1.8-0" });
            expect(joined.procedure[4]?.environment?.package).toEqual({ name: "samtools", present: false });

            // The record is the ONE source of the R runtime packages: with no record, survival is absent.
            const withoutRecord = await joinEnvironment(answer, { farmLockFile: lockPath });
            expect(withoutRecord.environment_source).toEqual({ farm: "lock", image: "unknown", references: "unknown" });
            expect(withoutRecord.procedure[0]?.environment?.package).toEqual({ name: "survival", present: false });
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    it("reports the image record alone when no farm lock is bound", async () => {
        const base = mkdtempSync(join(tmpdir(), "inflexa-env-"));
        try {
            const recordPath = join(base, "image-packages.json");
            await Bun.write(
                recordPath,
                JSON.stringify({
                    schema: 1,
                    image: { repository: "ghcr.io/inflexa-ai/sandbox-base", version: "20260917-abc1234", arch: "arm64" },
                    runtimes: { python: "3.12.3", r: "4.6.0", node: "24.19.0" },
                    system_tools: [],
                    node: [],
                    r_base: [{ name: "stats", version: "4.6.0", priority: "base" }],
                }),
            );
            const answer = {
                match: "applicable" as const,
                snapshot: { date: "2026-09-16", digest: "sha256:abc" },
                procedure: [{ step: "model_design", rules: [], package: { name: "stats" } }],
                uncovered: [],
                flags: [],
                claims: [],
            };

            const joined = await joinEnvironment(answer, { imagePackagesFile: recordPath });

            expect(joined.environment_source).toEqual({ farm: "unknown", image: "record", references: "unknown" });
            expect(joined.procedure[0]?.environment?.package).toEqual({ name: "stats", present: true, version: "4.6.0" });
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});
