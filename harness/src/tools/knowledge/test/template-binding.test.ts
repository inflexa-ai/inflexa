import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseUnknownRecord } from "../../../lib/unknown-containers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { makeFakeSandboxAgentDeps } from "../../../agents/sandbox/__fixtures__/deps.js";
import { parseJsonAs } from "../../../lib/parse-json.js";
import { createSandboxAgents } from "../../../agents/sandbox/index.js";
import { stepWritePrefix } from "../../../workspace/paths.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { createWorkspaceMutator } from "../../workspace/mutator.js";
import { createDecisionRecordStore } from "../../workspace/decision-record.js";
import { contractAnswer, fakeKnowledgeClient, renderAnswer, SNAPSHOT, substituteRenderAnswer } from "../__fixtures__/fake-client.js";
import { decisionRecordPath } from "../../workspace/decision-record.js";
import { createKnowledgeTemplateTool, type TemplateBinding } from "../template.js";
import { presentAt, presentFind, presentGet } from "../../../lib/present.js";
import { awaitOk } from "../../../lib/test/result-assert.js";

const ANALYSIS = "analysis-001";
const TEMPLATE = "tpl-deseq2-two-group@1.0.0";
const COUNTS = "/analysis-001/data/inputs/f1/counts.csv";

/** The two-group binding of the plan: the shrinkage estimator, the count filter, a list-valued slot, and the grounding of the step. */
function binding(over: Partial<TemplateBinding> = {}): TemplateBinding {
    return {
        template: TEMPLATE,
        slots: { lfc_shrink: "apeglm", min_count: 10, covariates: ["batch", "sex"] },
        sources: { lfc_shrink: "doi:10.1093/bioinformatics/bty895", min_count: "doi:10.12688/f1000research.7035.1" },
        step: "T1S2",
        claims: ["R-0001@e7d0"],
        snapshot: SNAPSHOT.digest,
        local: contractAnswer().parameters.filter((slot) => slot.local === true),
        adaptable: contractAnswer()
            .parameters.filter((slot) => slot.adaptable)
            .map((slot) => slot.name),
        ...over,
    };
}

describe("knowledge_template with a binding", () => {
    let base: string;
    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), "kt-binding-"));
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });

    function build(bound: TemplateBinding | undefined, answers: Parameters<typeof fakeKnowledgeClient>[0] = {}) {
        const workspaceRoot = join(base, ANALYSIS);
        const workingDir = stepWritePrefix({ workspaceRoot, runId: "run-1", stepId: "T1S2" });
        const mutator = createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir });
        const fake = fakeKnowledgeClient(answers);
        const records = createDecisionRecordStore({ resolveWorkspaceRoot: () => Promise.resolve(workspaceRoot), writePrefix: workingDir });
        const tool = createKnowledgeTemplateTool({ client: fake.client, mutator, records, binding: bound });
        return { tool, workingDir, calls: fake.calls };
    }

    function asRecord(value: unknown): Record<string, unknown> {
        const record = parseUnknownRecord(value);
        if (record === undefined) throw new Error("the decision record is no object");
        return record;
    }

    async function recordOf(workingDir: string): Promise<Record<string, unknown>> {
        return asRecord(parseJsonAs(await readFile(join(workingDir, decisionRecordPath("tpl-deseq2-two-group.R")), "utf8"), z.json()));
    }

    it("rides the bound slots into the render request when the model sends no value for them", async () => {
        const { tool, workingDir, calls } = build(binding());
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ok" });
        expect(calls.render).toHaveLength(1);
        expect(calls.render[0]?.template).toBe(TEMPLATE);
        // The count path is local: it is bound here and never in the request.
        expect(calls.render[0]?.slots).toEqual({ lfc_shrink: "apeglm", min_count: 10, covariates: ["batch", "sex"] });
        expect(await readFile(join(workingDir, "scripts", "tpl-deseq2-two-group.R"), "utf8")).toContain(`COUNTS <- ${JSON.stringify(COUNTS)}`);
        const record = await recordOf(workingDir);
        expect(record.bound_slots).toEqual([
            { slot: "lfc_shrink", value: "apeglm", source: "doi:10.1093/bioinformatics/bty895" },
            { slot: "min_count", value: 10, source: "doi:10.12688/f1000research.7035.1" },
            { slot: "covariates", value: ["batch", "sex"], source: "plan" },
        ]);
        expect(record.settings_overrides).toEqual([]);
        expect(record.departures).toEqual([]);
        expect(record.script_path).toBe(`/${ANALYSIS}/runs/run-1/T1S2/scripts/tpl-deseq2-two-group.R`);
    });

    it("refuses a render that sends no value for an excluded slot, or a value with no override", async () => {
        const departures = [{ rule: "R-0001@e7d0", setting: "lfc_shrink", reason: "the plan reports the unshrunk fold changes" }];
        const { tool, calls } = build(binding({ slots: {}, sources: {}, departures, excluded: ["lfc_shrink"] }));
        const { ctx } = makeToolContext();

        const attempts: Record<string, string>[] = [{ counts_path: COUNTS }, { counts_path: COUNTS, lfc_shrink: "apeglm" }];
        for (const slots of attempts) {
            const out = (await tool.execute({ template: TEMPLATE, slots }, ctx))._unsafeUnwrap();
            expect(out).toMatchObject({ match: "rejected", issues: [{ slot: "lfc_shrink", reason: "not applied by the plan" }] });
        }
        expect(calls.render).toHaveLength(0);
    });

    it("renders an excluded slot with the value and the override of the model, and keeps the override with no plan value", async () => {
        const departures = [{ rule: "R-0001@e7d0", setting: "lfc_shrink", reason: "the plan reports the unshrunk fold changes" }];
        const reason = "the plan reports the unshrunk fold changes";
        const { tool, workingDir, calls } = build(binding({ slots: {}, sources: {}, departures, excluded: ["lfc_shrink"] }));
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS, lfc_shrink: "none" }, overrides: [{ slot: "lfc_shrink", reason }] }, ctx)
        )._unsafeUnwrap();

        expect(out).toMatchObject({ status: "ok" });
        expect(calls.render[0]?.slots).toEqual({ lfc_shrink: "none" });
        expect((await recordOf(workingDir)).settings_overrides).toEqual([{ slot: "lfc_shrink", plan_value: null, new_value: "none", reason }]);
    });

    it("keeps the departures of the plan step in the decision record, and the bound value of a departure in the bound slots", async () => {
        const departures = [
            { rule: "R-0001@e7d0", setting: "min_count", value: 5, reason: "the panel holds 364 targets" },
            { rule: "R-0001@e7d0", reason: "the plan runs no GC diagnostic" },
        ];
        const { tool, workingDir } = build(binding({ slots: { min_count: 5 }, sources: { min_count: "departure from R-0001@e7d0" }, departures }));
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ok" });
        const record = await recordOf(workingDir);
        expect(record.departures).toEqual(departures);
        expect(record.bound_slots).toEqual([{ slot: "min_count", value: 5, source: "departure from R-0001@e7d0" }]);
    });

    it("binds the render to the plan step: the step, its claims, and the pinned release ride in the request, and the local slots come from the binding", async () => {
        const { tool, calls } = build(binding());
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ok", local_slots: ["counts_path"] });
        expect(calls.render[0]?.options).toEqual({ step: "T1S2", claims: ["R-0001@e7d0"], expectedSnapshot: SNAPSHOT.digest });
        // The binding names the local slots, thus no contract is read at render time.
        expect(calls.contract).toHaveLength(0);
    });

    it("binds a bound local slot on the machine when the model omits it, and lists it among the bound slots", async () => {
        const { tool, workingDir, calls } = build(binding({ slots: { lfc_shrink: "apeglm", condition_column: "dex" }, sources: { condition_column: "plan" } }));
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ok", local_slots: ["counts_path", "condition_column"] });
        expect(calls.render[0]?.slots).toEqual({ lfc_shrink: "apeglm" });
        const record = await recordOf(workingDir);
        expect(record.bound_slots).toEqual([
            { slot: "lfc_shrink", value: "apeglm", source: "plan" },
            { slot: "condition_column", value: "dex", source: "plan" },
        ]);
    });

    it("refuses an unknown slot name before anything leaves the machine", async () => {
        const { tool, calls } = build(binding());
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS, count_path: "/analysis-001/SENTINEL.csv" } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ match: "rejected", issues: [{ slot: "count_path", reason: "the template has no such adaptable slot" }] });
        expect(calls.render).toHaveLength(0);
        expect(calls.contract).toHaveLength(0);
    });

    it("renders when the model sends every bound value as it is, the list included", async () => {
        const { tool, calls } = build(binding());
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS, lfc_shrink: "apeglm", min_count: 10, covariates: ["batch", "sex"] } }, ctx)
        )._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ok" });
        expect(calls.render).toHaveLength(1);
    });

    it("refuses a value that differs from the bound value without an override, before the service call and before any write", async () => {
        const { tool, workingDir, calls } = build(binding());
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS, lfc_shrink: "ashr" } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ match: "rejected" });
        if (!("match" in out) || out.match !== "rejected") return;
        expect(out.issues).toHaveLength(1);
        const issue = presentAt(out.issues, 0);
        expect(issue.slot).toBe("lfc_shrink");
        expect(issue.message).toContain('"apeglm"');
        expect(issue.message).toContain("doi:10.1093/bioinformatics/bty895");
        expect(issue.message).toContain("name the slot in overrides with the reason");
        expect(issue.permitted).toEqual(['"apeglm"']);
        expect(calls.render).toHaveLength(0);
        expect(await Bun.file(join(workingDir, "scripts", "tpl-deseq2-two-group.R")).exists()).toBe(false);
        expect(await Bun.file(join(workingDir, decisionRecordPath("tpl-deseq2-two-group.R"))).exists()).toBe(false);
        expect(tool.describeResult?.({ template: TEMPLATE, slots: {} }, out)).toBe("rejected");
    });

    it("names every differing slot in one refusal, a changed list included", async () => {
        const { tool, calls } = build(binding());
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: TEMPLATE, slots: { lfc_shrink: "none", min_count: 5, covariates: ["batch"] } }, ctx))._unsafeUnwrap();
        if (!("match" in out) || out.match !== "rejected") throw new Error("expected a refusal");
        expect(out.issues.map((issue) => issue.slot)).toEqual(["lfc_shrink", "min_count", "covariates"]);
        expect(calls.render).toHaveLength(0);
    });

    it("renders a changed value under an override with a reason and records the change on disk", async () => {
        const { tool, workingDir, calls } = build(binding());
        const { ctx } = makeToolContext();
        const reason = "the apeglm prior fails on this contrast; ashr is the documented fallback";
        const out = (
            await tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS, lfc_shrink: "ashr" }, overrides: [{ slot: "lfc_shrink", reason }] }, ctx)
        )._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ok" });
        expect(calls.render[0]?.slots).toEqual({ lfc_shrink: "ashr", min_count: 10, covariates: ["batch", "sex"] });
        const record = await recordOf(workingDir);
        expect(record.settings_overrides).toEqual([{ slot: "lfc_shrink", plan_value: "apeglm", new_value: "ashr", reason }]);
        expect(record.bound_slots).toHaveLength(3);
    });

    it("records no override for a slot whose value the model did not change, or did not send", async () => {
        const { tool, workingDir } = build(binding());
        const { ctx } = makeToolContext();
        await awaitOk(
            tool.execute(
                {
                    template: TEMPLATE,
                    slots: { counts_path: COUNTS, lfc_shrink: "apeglm" },
                    overrides: [
                        { slot: "lfc_shrink", reason: "no change" },
                        { slot: "min_count", reason: "not sent" },
                    ],
                },
                ctx,
            ),
        );
        expect((await recordOf(workingDir)).settings_overrides).toEqual([]);
    });

    it("refuses a template reference that differs from the bound one, before the service call", async () => {
        const { tool, calls } = build(binding());
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: "tpl-deseq2-blocked@1.0.0", slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        if (!("match" in out) || out.match !== "rejected") throw new Error("expected a refusal");
        const issue = out.issues.find((candidate) => candidate.field === "template");
        expect(issue?.message).toContain(TEMPLATE);
        expect(issue?.permitted).toEqual([TEMPLATE]);
        expect(calls.render).toHaveLength(0);
    });

    it("accepts overrides at the schema and refuses an entry without a reason", () => {
        const { tool } = build(binding());
        expect(tool.inputSchema.safeParse({ template: TEMPLATE, slots: {}, overrides: [{ slot: "lfc_shrink", reason: "x" }] }).success).toBe(true);
        expect(tool.inputSchema.safeParse({ template: TEMPLATE, slots: {} }).success).toBe(true);
        expect(tool.inputSchema.safeParse({ template: TEMPLATE, slots: {}, overrides: [{ slot: "lfc_shrink", reason: "" }] }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ template: TEMPLATE, slots: {}, overrides: [{ slot: "lfc_shrink" }] }).success).toBe(false);
    });

    it("writes empty bound slots and overrides without a binding, and accepts any template reference", async () => {
        const { tool, workingDir, calls } = build(undefined);
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: "tpl-deseq2-two-group", slots: { lfc_shrink: "ashr", counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ok" });
        expect(calls.render[0]?.slots).toEqual({ lfc_shrink: "ashr" });
        // Without a binding the request carries no step, no claims, and no pin.
        expect(calls.render[0]?.options).toEqual({});
        const record = await recordOf(workingDir);
        expect(record.bound_slots).toEqual([]);
        expect(record.settings_overrides).toEqual([]);
    });

    it("returns the method and the method of record of a substitute template in the output", async () => {
        const substitute = substituteRenderAnswer();
        const { tool } = build(binding({ template: "tpl-decoupler-scores@1.0.0", slots: { gene_set_collection: "msigdb_hallmark_human" }, sources: {} }), {
            render: substitute,
        });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: "tpl-decoupler-scores@1.0.0", slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        if (!("status" in out) || out.status !== "ok") throw new Error("expected a render");
        expect(out.template.method).toEqual(substitute.template.method);
        const substituteFor = substitute.template.substitute_for;
        if (substituteFor === undefined) throw new Error("the substitute_for reference is absent");
        expect(out.template.substitute_for).toEqual(substituteFor);
        expect(out.run_with).toBe("python3 scripts/tpl-decoupler-scores.py");

        const plain = build(binding(), { render: renderAnswer() });
        const direct = (await plain.tool.execute({ template: TEMPLATE, slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        if (!("status" in direct) || direct.status !== "ok") throw new Error("expected a render");
        expect(direct.template.method).toEqual(renderAnswer().template.method);
        expect(direct.template.substitute_for).toBeUndefined();
    });
});

describe("the binding rides the step coordinates into the template tool", () => {
    it("reaches knowledge_template through createSandboxAgents when a client is bound", async () => {
        const fake = fakeKnowledgeClient();
        const base = makeFakeSandboxAgentDeps();
        const agents = createSandboxAgents({ ...base, knowledge: fake.client, step: { ...base.step, templateBinding: binding() } });
        const tool = presentFind(
            presentGet(agents, "bulk-transcriptomics-agent").tools,
            (candidate) => candidate.id === "knowledge_template",
            "the knowledge_template tool",
        );
        expect(tool).toBeDefined();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: TEMPLATE, slots: { lfc_shrink: "ashr" } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ match: "rejected" });
        expect(fake.calls.render).toHaveLength(0);
    });

    it("binds nothing when the step coordinates carry no binding", async () => {
        // The fake answers unavailable, thus the call reaches the service and the tool writes nothing.
        const fake = fakeKnowledgeClient({ render: { match: "unavailable", reason: "off" } });
        const agents = createSandboxAgents({ ...makeFakeSandboxAgentDeps(), knowledge: fake.client });
        const tool = presentFind(
            presentGet(agents, "bulk-transcriptomics-agent").tools,
            (candidate) => candidate.id === "knowledge_template",
            "the knowledge_template tool",
        );
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ template: "tpl-deseq2-blocked@1.0.0", slots: { lfc_shrink: "ashr" } }, ctx))._unsafeUnwrap();
        expect(out).toEqual({ match: "unavailable", reason: "off" });
        expect(fake.calls.render).toHaveLength(1);
        expect(fake.calls.render[0]?.slots).toEqual({ lfc_shrink: "ashr" });
    });
});
