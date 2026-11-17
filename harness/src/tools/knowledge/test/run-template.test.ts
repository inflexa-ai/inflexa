import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { makeFakeSandboxAgentDeps } from "../../../agents/sandbox/__fixtures__/deps.js";
import { createSandboxAgents } from "../../../agents/sandbox/index.js";
import { presentAt, presentFind, presentGet } from "../../../lib/present.js";
import type { LoopStep } from "../../../loop/run-loop.js";
import type { ToolCallOutput } from "../../../loop/tool-adapter.js";
import { ProvenanceCollector } from "../../../provenance/collector.js";
import { leaseOverClient } from "../../../sandbox/__fixtures__/leases.js";
import type { ExecRequest, ExecResult, SandboxRef } from "../../../sandbox/types.js";
import { stepWritePrefix } from "../../../workspace/paths.js";
import { readToolCallRecord } from "../../define-tool.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { createWorkspaceMutator } from "../../workspace/mutator.js";
import { contractAnswer, fakeKnowledgeClient, renderAnswer, SNAPSHOT, substituteRenderAnswer } from "../__fixtures__/fake-client.js";
import { createRunTemplateTool, hasSuccessfulTemplateRun, RUN_TEMPLATE_TOOL_ID, type TemplateBinding } from "../run-template.js";

const ANALYSIS = "analysis-001";
const TEMPLATE = "tpl-deseq2-two-group@1.0.0";
const COUNTS = "/analysis-001/data/inputs/f1/counts.csv";
const WORK_DIR = "/analysis-001/runs/run-1/T1S2/work";
const REF: SandboxRef = { sandboxId: "sb-1", host: "127.0.0.1", port: 8765, backend: "docker" };

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

describe("run_template", () => {
    let base: string;
    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), "run-template-"));
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });

    function build(opts: { binding?: TemplateBinding; template?: string; answers?: Parameters<typeof fakeKnowledgeClient>[0]; exitCode?: number } = {}) {
        const workspaceRoot = join(base, ANALYSIS);
        const workingDir = stepWritePrefix({ workspaceRoot, runId: "run-1", stepId: "T1S2" });
        const collector = new ProvenanceCollector({ stepId: "T1S2", runId: "run-1" });
        const mutator = createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir, lineageCollector: collector });
        const fake = fakeKnowledgeClient(opts.answers ?? {});
        const execs: ExecRequest[] = [];
        const result: ExecResult = { execId: "wf:1", exitCode: opts.exitCode ?? 0, stdout: "done\n", stderr: "", durationMs: 7, timedOut: false };
        const lease = leaseOverClient(
            {
                exec: (_ref, request) => {
                    execs.push(request);
                    return Promise.resolve(result);
                },
            },
            REF,
        );
        const tool = createRunTemplateTool({
            source: fake.client,
            template: opts.template ?? TEMPLATE,
            binding: opts.binding,
            mutator,
            lease,
            workingDir: WORK_DIR,
            lineageCollector: collector,
            mountRoot: `/${ANALYSIS}`,
        });
        return { tool, workingDir, calls: fake.calls, execs, collector };
    }

    it("renders the bound slots, binds the local slots on the machine, writes the script, and runs it", async () => {
        const { tool, workingDir, calls, execs } = build({ binding: binding() });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();

        expect(out).toMatchObject({ status: "ran", exitCode: 0, script_path: `${WORK_DIR}/tpl-deseq2-two-group.R` });
        expect(calls.render).toHaveLength(1);
        expect(calls.render[0]?.template).toBe(TEMPLATE);
        // The count path is local: it is bound here and never in the request.
        expect(calls.render[0]?.slots).toEqual({ lfc_shrink: "apeglm", min_count: 10, covariates: ["batch", "sex"] });
        expect(calls.render[0]?.options).toEqual({ step: "T1S2", claims: ["R-0001@e7d0"], expectedSnapshot: SNAPSHOT.digest });
        expect(calls.contract).toHaveLength(0);
        expect(await readFile(join(workingDir, "tpl-deseq2-two-group.R"), "utf8")).toContain(`COUNTS <- ${JSON.stringify(COUNTS)}`);
        expect(execs.map((request) => ({ command: request.command, cwd: request.cwd }))).toEqual([
            { command: ["Rscript", `${WORK_DIR}/tpl-deseq2-two-group.R`], cwd: WORK_DIR },
        ]);
    });

    it("writes the script at the path that the agent names, and runs it in the directory that it names", async () => {
        const { tool, workingDir, execs } = build({ binding: binding() });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: COUNTS }, script_path: "de/fit.R", cwd: "de" }, ctx))._unsafeUnwrap();

        expect(out).toMatchObject({ status: "ran", script_path: `${WORK_DIR}/de/fit.R` });
        expect(await Bun.file(join(workingDir, "de", "fit.R")).exists()).toBe(true);
        expect(execs[0]?.cwd).toBe(`${WORK_DIR}/de`);
    });

    it("gives a failed run as data with its exit code", async () => {
        const { tool } = build({ binding: binding(), exitCode: 2 });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();

        expect(out).toMatchObject({ status: "ran", exitCode: 2 });
        expect(tool.describeResult?.({ slots: {} }, out)).toBe("exit 2");
    });

    it("carries the facts of the render on the provenance record of the script", async () => {
        const reason = "the apeglm prior fails on this contrast";
        const { tool, collector } = build({ binding: binding() });
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute({ slots: { counts_path: COUNTS, lfc_shrink: "ashr" }, overrides: [{ slot: "lfc_shrink", reason }] }, ctx)
        )._unsafeUnwrap();
        tool.foldCallRecord?.(readToolCallRecord(out));

        const record = presentFind(collector.getRecords(), (candidate) => candidate.outputPath === "work/tpl-deseq2-two-group.R", "the record of the script");
        expect(record.producer).toMatchObject({
            type: "file_tool",
            tool: RUN_TEMPLATE_TOOL_ID,
            template: {
                template: "tpl-deseq2-two-group@1.0.0",
                snapshot: SNAPSHOT.digest,
                overrides: [{ slot: "lfc_shrink", reason }],
                environmentMatch: "exact",
            },
        });
    });

    it("refuses a render that sends no value for an excluded slot, or a value with no override", async () => {
        const departures = [{ rule: "R-0001@e7d0", setting: "lfc_shrink", reason: "the plan reports the unshrunk fold changes" }];
        const { tool, calls, execs } = build({ binding: binding({ slots: {}, sources: {}, departures, excluded: ["lfc_shrink"] }) });
        const { ctx } = makeToolContext();

        const attempts: Record<string, string>[] = [{ counts_path: COUNTS }, { counts_path: COUNTS, lfc_shrink: "apeglm" }];
        for (const slots of attempts) {
            const out = (await tool.execute({ slots }, ctx))._unsafeUnwrap();
            expect(out).toMatchObject({ match: "rejected", issues: [{ slot: "lfc_shrink", reason: "not applied by the plan" }] });
        }
        expect(calls.render).toHaveLength(0);
        expect(execs).toHaveLength(0);
    });

    it("refuses an unknown slot name before anything leaves the machine", async () => {
        const { tool, calls } = build({ binding: binding() });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: COUNTS, count_path: "/analysis-001/SENTINEL.csv" } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ match: "rejected", issues: [{ slot: "count_path", reason: "the template has no such adaptable slot" }] });
        expect(calls.render).toHaveLength(0);
        expect(calls.contract).toHaveLength(0);
    });

    it("refuses a value that differs from the bound value without an override, before the render and before any write", async () => {
        const { tool, workingDir, calls } = build({ binding: binding() });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: COUNTS, lfc_shrink: "ashr" } }, ctx))._unsafeUnwrap();
        if (!("match" in out) || out.match !== "rejected") throw new Error("expected a refusal");
        const issue = presentAt(out.issues, 0);
        expect(issue.slot).toBe("lfc_shrink");
        expect(issue.message).toContain("doi:10.1093/bioinformatics/bty895");
        expect(issue.permitted).toEqual(['"apeglm"']);
        expect(calls.render).toHaveLength(0);
        expect(await Bun.file(join(workingDir, "tpl-deseq2-two-group.R")).exists()).toBe(false);
    });

    it("reads the contract of the template when the host bound nothing", async () => {
        const { tool, calls } = build();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { lfc_shrink: "ashr", counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ran" });
        expect(calls.contract).toEqual([{ template: TEMPLATE }]);
        expect(calls.render[0]?.slots).toEqual({ lfc_shrink: "ashr" });
        // Without a binding the request carries no step, no claims, and no pin.
        expect(calls.render[0]?.options).toEqual({});
    });

    it("gives the refusal of the source as data, and runs nothing", async () => {
        const { tool, execs } = build({ binding: binding(), answers: { render: { match: "unavailable", reason: "off" } } });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        expect(out).toEqual({ match: "unavailable", reason: "off" });
        expect(execs).toHaveLength(0);
    });

    it("runs a Python template with python3, and returns the method of record of a substitute", async () => {
        const substitute = substituteRenderAnswer();
        const { tool, execs } = build({
            template: "tpl-decoupler-scores@1.0.0",
            binding: binding({ template: "tpl-decoupler-scores@1.0.0", slots: {}, sources: {} }),
            answers: { render: substitute },
        });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        if (!("status" in out) || out.status !== "ran") throw new Error("expected a run");
        expect(out.template.substitute_for).toEqual(substitute.template.substitute_for);
        expect(execs[0]?.command).toEqual(["python3", `${WORK_DIR}/tpl-decoupler-scores.py`]);
        expect(renderAnswer().template.substitute_for).toBeUndefined();
    });
});

describe("run_template and the facts of the machine", () => {
    let base: string;
    beforeEach(() => {
        base = mkdtempSync(join(tmpdir(), "run-template-machine-"));
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });

    function build(answers: Parameters<typeof fakeKnowledgeClient>[0] = {}, paths: { farmLockFile?: string; imagePackagesFile?: string } = {}) {
        const workspaceRoot = join(base, ANALYSIS);
        const workingDir = stepWritePrefix({ workspaceRoot, runId: "run-1", stepId: "T1S2" });
        const collector = new ProvenanceCollector({ stepId: "T1S2", runId: "run-1" });
        const mutator = createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir, lineageCollector: collector });
        const fake = fakeKnowledgeClient(answers);
        const result: ExecResult = { execId: "wf:1", exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
        const lease = leaseOverClient({ exec: () => Promise.resolve(result) }, REF);
        const tool = createRunTemplateTool({ source: fake.client, template: TEMPLATE, mutator, lease, workingDir: WORK_DIR, ...paths });
        return { tool, workingDir, calls: fake.calls, collector };
    }

    it("never sends a local value to the source", async () => {
        const sentinel = "/analysis-001/data/inputs/SENTINEL-7f3a9c/counts.csv";
        const { tool, calls } = build();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: sentinel, condition_column: "SENTINEL_column", lfc_shrink: "ashr" } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ran" });
        expect(calls.render[0]?.slots).toEqual({ lfc_shrink: "ashr" });
        expect(JSON.stringify(calls)).not.toContain("SENTINEL");
    });

    it("refuses a local value that the contract refuses, with the description of the slot, before the render and any write", async () => {
        const { tool, workingDir, calls } = build();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: 42 } }, ctx))._unsafeUnwrap();
        expect(out).toMatchObject({
            match: "rejected",
            issues: [{ slot: "counts_path", reason: "a non-empty string is required. The slot: The count table file." }],
        });
        expect(calls.render).toHaveLength(0);
        expect(await Bun.file(join(workingDir, "tpl-deseq2-two-group.R")).exists()).toBe(false);
    });

    it("keeps a setting that the script does not read out of the facts of the render", async () => {
        const answer = renderAnswer();
        const unread = { name: "quantifier", value: "salmon", source: "default", adaptable: true, lines: [], read: false };
        const { tool, collector } = build({ render: { ...answer, slots: [...answer.slots, unread] } });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        tool.foldCallRecord?.(readToolCallRecord(out));
        const record = presentFind(collector.getRecords(), (candidate) => candidate.outputPath === "work/tpl-deseq2-two-group.R", "the record of the script");
        if (record.producer.type !== "file_tool") throw new Error("the script has no file-tool record");
        expect(record.producer.template?.settings).toEqual([{ name: "counts_path", value: COUNTS, source: "caller", lines: [1] }]);
    });

    it("passes a snapshot mismatch through as data, and writes and runs nothing", async () => {
        const mismatch = { match: "snapshot_mismatch" as const, message: "another release", expected: "sha256:aa", served: SNAPSHOT };
        const { tool, workingDir } = build({ render: mismatch });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ slots: { counts_path: COUNTS } }, ctx))._unsafeUnwrap();
        expect(out).toEqual(mismatch);
        expect(tool.describeResult?.({ slots: {} }, out)).toBe("snapshot_mismatch");
        expect(await Bun.file(join(workingDir, "tpl-deseq2-two-group.R")).exists()).toBe(false);
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
        const { tool, calls } = build({}, { farmLockFile: lockPath, imagePackagesFile: recordPath });
        const { ctx } = makeToolContext();
        (await tool.execute({ slots: {} }, ctx))._unsafeUnwrap();
        const farm = calls.render[0]?.farm;
        expect(farm?.some((pkg) => pkg.name === "DESeq2" && pkg.version === "1.52.0")).toBe(true);
        // A template that pins a package of the R runtime matches against the version the image ships.
        expect(farm?.some((pkg) => pkg.name === "survival" && pkg.version === "3.8-6")).toBe(true);

        const bare = build();
        (await bare.tool.execute({ slots: {} }, ctx))._unsafeUnwrap();
        expect(bare.calls.render[0]?.farm).toBeUndefined();
    });

    it("refuses a script path that leaves the working directory at the schema", () => {
        const { tool } = build();
        expect(tool.inputSchema.safeParse({ slots: {}, script_path: "/etc/evil.R" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ slots: {}, script_path: "de/fit.R" }).success).toBe(true);
        expect(tool.inputSchema.safeParse({ slots: {}, overrides: [{ slot: "lfc_shrink", reason: "" }] }).success).toBe(false);
    });
});

describe("hasSuccessfulTemplateRun", () => {
    function stepWith(toolName: string, value: Extract<ToolCallOutput, { outcome: "ok" }>["value"]): LoopStep {
        return {
            finishReason: "tool-calls",
            calls: [{ toolCallId: "c1", toolName, input: {}, output: { outcome: "ok", value }, refused: false, answered: true }],
        };
    }

    it("holds only for a run of the template that ended with exit code 0", () => {
        expect(hasSuccessfulTemplateRun([stepWith(RUN_TEMPLATE_TOOL_ID, { status: "ran", exitCode: 0 })])).toBe(true);
        expect(hasSuccessfulTemplateRun([stepWith(RUN_TEMPLATE_TOOL_ID, { status: "ran", exitCode: 1 })])).toBe(false);
        expect(hasSuccessfulTemplateRun([stepWith(RUN_TEMPLATE_TOOL_ID, { match: "rejected" })])).toBe(false);
        expect(hasSuccessfulTemplateRun([stepWith("execute_command", { status: "ran", exitCode: 0 })])).toBe(false);
    });
});

describe("the template of a step reaches the agent of the step", () => {
    it("gives run_template and the template-step prompt to the agent of a template step only", () => {
        const fake = fakeKnowledgeClient();
        const base = makeFakeSandboxAgentDeps();
        const templateStep = presentGet(
            createSandboxAgents({ ...base, templateSource: fake.client, step: { ...base.step, template: { ref: TEMPLATE, binding: binding() } } }),
            "analyst",
        );
        const openStep = presentGet(createSandboxAgents({ ...base, templateSource: fake.client }), "analyst");

        expect(templateStep.tools.some((tool) => tool.id === RUN_TEMPLATE_TOOL_ID)).toBe(true);
        expect(openStep.tools.some((tool) => tool.id === RUN_TEMPLATE_TOOL_ID)).toBe(false);
        expect(templateStep.systemPrompt).toContain("# Template Step");
        expect(openStep.systemPrompt).not.toContain("# Template Step");
    });

    it("gives no run_template when no template source is bound", () => {
        const base = makeFakeSandboxAgentDeps();
        const agent = presentGet(createSandboxAgents({ ...base, step: { ...base.step, template: { ref: TEMPLATE } } }), "analyst");
        expect(agent.tools.some((tool) => tool.id === RUN_TEMPLATE_TOOL_ID)).toBe(false);
    });
});
