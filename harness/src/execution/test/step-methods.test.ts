import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { errAsync } from "neverthrow";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { RunSession } from "../../auth/types.js";
import { ProvenanceCollector } from "../../provenance/collector.js";
import type { ClaimView, Grounding } from "../../schemas/workflow-state.js";
import type { Querier } from "../../state/db.js";
import { reply, scriptedModel, text } from "../../testing.js";
import { createFileMetadataCell } from "../../tools/sandbox/submit-file-metadata.js";
import type { PostStepContext } from "../../workflows/sandbox-step.js";
import { generateStepSummaryAndWrite, type PostStepPipelineDeps } from "../post-step-pipeline.js";
import {
    MAX_METHODS_CLAIMS,
    METHODS_HEADING,
    buildStepMethods,
    readStepDecisionRecords,
    renderMethodsBlock,
    restoreStepDecisionRecords,
    withMethodsBlock,
    type StepDecisionRecord,
} from "../step-methods.js";
import { stepDecisionRecordDir } from "../../workspace/paths.js";
import { computeSha256 } from "../../lib/fs-helpers.js";

const SNAPSHOT = "sha256:a559d904";

const GROUNDING: Grounding = {
    status: "grounded",
    snapshot: SNAPSHOT,
    claims: ["R-0028@d560", "R-0056@d560"],
    template: "tpl-edger-ql@1.8.0",
    reason: "edgeR QL per R-0028",
};

function view(id: string, overrides: Partial<ClaimView> = {}): ClaimView {
    return {
        id,
        snapshot: SNAPSHOT,
        title: `The title of ${id}`,
        statement: `The statement of ${id}`,
        strength: "consensus",
        evidence: [],
        license: "CC-BY-4.0",
        ...overrides,
    };
}

function record(overrides: Partial<StepDecisionRecord> = {}): StepDecisionRecord {
    return {
        template: {
            id: "tpl-edger-ql",
            version: "1.8.0",
            label: "edgeR quasi-likelihood F-test, two-group differential expression",
            method: { id: "M-0003", label: "edgeR quasi-likelihood F-test" },
        },
        snapshot: { digest: SNAPSHOT },
        claims: [
            { claim: "R-0028@d560", title: "The record title of R-0028" },
            { claim: "R-0002@6b60", title: "Pre-filter: keep a gene with at least 10 counts" },
        ],
        citations: [{ doi: "10.1093/bioinformatics/btp616", title: "edgeR: a Bioconductor package", year: 2010 }],
        environment: { match: "compatible" },
        script_path: "/an-1/runs/run-1/T1S2/scripts/tpl-edger-ql_A.R",
        ...overrides,
    };
}

// ── buildStepMethods ─────────────────────────────────────────────────

describe("buildStepMethods", () => {
    it("names the claims of the grounding first with the title of the view, then the claims of the records", () => {
        const methods = buildStepMethods({ grounding: GROUNDING, claimViews: [view("R-0028@d560"), view("R-0056@d560")], records: [record()] });
        expect(methods?.claims).toEqual([
            { id: "R-0028@d560", title: "The title of R-0028@d560", strength: "consensus" },
            { id: "R-0056@d560", title: "The title of R-0056@d560", strength: "consensus" },
            { id: "R-0002@6b60", title: "Pre-filter: keep a gene with at least 10 counts", strength: undefined },
        ]);
        expect(methods?.grounding).toBe("grounded");
        expect(methods?.snapshot).toBe(SNAPSHOT);
        expect(methods?.license).toBe("CC-BY-4.0");
        expect(methods?.templates).toEqual([
            {
                id: "tpl-edger-ql",
                version: "1.8.0",
                label: "edgeR quasi-likelihood F-test, two-group differential expression",
                method: { id: "M-0003", label: "edgeR quasi-likelihood F-test" },
                environmentMatch: "compatible",
                script: "scripts/tpl-edger-ql_A.R",
            },
        ]);
    });

    it("gives one source for each DOI of the records and of the evidence of the views", () => {
        const evidence = [
            { doi: "10.1093/BIOINFORMATICS/btp616", title: "edgeR again", year: 2010, direction: "supports" },
            { pmid: "26937343", title: "A permutation study", year: 2016, direction: "supports" },
            { title: "A source with no identifier", year: 2020, direction: "supports" },
        ];
        const methods = buildStepMethods({ grounding: GROUNDING, claimViews: [view("R-0056@d560", { evidence })], records: [record(), record()] });
        expect(methods?.sources).toEqual([
            { doi: "10.1093/bioinformatics/btp616", pmid: undefined, url: undefined, title: "edgeR: a Bioconductor package", year: 2010 },
            { doi: undefined, pmid: "26937343", url: undefined, title: "A permutation study", year: 2016 },
        ]);
    });

    it("gives the claims and their sources from the views when the step kept no decision record", () => {
        const evidence = [{ doi: "10.1186/s13059-014-0550-8", title: "DESeq2", year: 2014, direction: "supports" }];
        const methods = buildStepMethods({ grounding: GROUNDING, claimViews: [view("R-0028@d560", { evidence })], records: [] });
        expect(methods?.templates).toEqual([]);
        expect(methods?.claims.map((claim) => claim.id)).toEqual(["R-0028@d560", "R-0056@d560"]);
        expect(methods?.claims[1]?.title).toBeUndefined();
        expect(methods?.sources.map((source) => source.doi)).toEqual(["10.1186/s13059-014-0550-8"]);
    });

    it("gives no methods for a step with no grounding and no record", () => {
        expect(buildStepMethods({ claimViews: [], records: [] })).toBeUndefined();
    });

    it("takes the snapshot of a record when the step has no grounding, and renders it", () => {
        const methods = buildStepMethods({ claimViews: [], records: [record()] });
        expect(methods?.snapshot).toBe(SNAPSHOT);
        if (!methods) throw new Error("the step has methods");
        const block = renderMethodsBlock(methods);
        expect(block).toContain(`- Knowledge release: \`${SNAPSHOT}\``);
        expect(block).not.toContain("- Grounding:");
    });

    it("gives a claim of the grounding with no title in its view the title of a record", () => {
        const methods = buildStepMethods({ grounding: GROUNDING, claimViews: [view("R-0028@d560", { title: undefined })], records: [record()] });
        expect(methods?.claims[0]).toEqual({ id: "R-0028@d560", title: "The record title of R-0028", strength: "consensus" });
    });

    it("bounds the claims and counts the tail", () => {
        const claims = Array.from({ length: MAX_METHODS_CLAIMS + 5 }, (_, i) => ({ claim: `R-${i}@d560` }));
        const methods = buildStepMethods({ claimViews: [], records: [record({ claims })] });
        expect(methods?.claims).toHaveLength(MAX_METHODS_CLAIMS);
        expect(methods?.claimsOmitted).toBe(5);
        expect(methods?.sourcesOmitted).toBeUndefined();
    });
});

// ── renderMethodsBlock ───────────────────────────────────────────────

describe("renderMethodsBlock", () => {
    it("renders the grounding, the template with its method, each rule, each source, and the license", () => {
        const methods = buildStepMethods({ grounding: GROUNDING, claimViews: [view("R-0028@d560")], records: [record()] });
        if (!methods) throw new Error("the step has methods");
        const block = renderMethodsBlock(methods);
        expect(block.startsWith(METHODS_HEADING)).toBe(true);
        expect(block).toContain(`- Grounding: grounded\n- Knowledge release: \`${SNAPSHOT}\``);
        expect(block).toContain(
            "- Template `tpl-edger-ql@1.8.0`: edgeR quasi-likelihood F-test, two-group differential expression (method M-0003, edgeR quasi-likelihood F-test; environment compatible; script `scripts/tpl-edger-ql_A.R`)",
        );
        expect(block).toContain("- R-0028@d560 (consensus): The title of R-0028@d560");
        expect(block).toContain("- R-0056@d560\n");
        expect(block).toContain("- edgeR: a Bioconductor package (2010). doi:10.1093/bioinformatics/btp616");
        expect(block).toContain("under CC-BY-4.0.");
    });

    it("renders each departure of the grounding with its rule, its setting, the value of the plan, and the reason", () => {
        const grounding: Grounding = {
            ...GROUNDING,
            departures: [
                { rule: "R-0028@d560", setting: "prior_count", value: 3, reason: "the panel holds 364 targets" },
                { rule: "R-0056@d560", setting: "permutations", reason: "the cohort is too small for a permutation check" },
                { rule: "R-0056@d560", reason: "the plan reports no empirical P" },
            ],
        };
        const methods = buildStepMethods({ grounding, claimViews: [], records: [record()] });
        if (!methods) throw new Error("the step has methods");
        expect(methods.departures).toEqual(grounding.departures);
        const block = renderMethodsBlock(methods);
        expect(block).toContain(
            [
                "Departures from the rules:",
                "",
                "- R-0028@d560: `prior_count` = 3. the panel holds 364 targets",
                "- R-0056@d560: `permutations` not applied. the cohort is too small for a permutation check",
                "- R-0056@d560: the plan reports no empirical P",
            ].join("\n"),
        );
    });

    it("gives no departures for a grounding with none, and renders no departure section", () => {
        const methods = buildStepMethods({ grounding: GROUNDING, claimViews: [], records: [record()] });
        if (!methods) throw new Error("the step has methods");
        expect(methods.departures).toBeUndefined();
        expect(renderMethodsBlock(methods)).not.toContain("Departures");
    });

    it("says that the step kept no valid decision record, and names no origin of the scripts", () => {
        const block = renderMethodsBlock({ grounding: "ungrounded", templates: [], claims: [], sources: [] });
        expect(block).toContain("- Template: the step kept no valid decision record.");
        expect(block).not.toContain("agent wrote");
        expect(block).not.toContain("Rules:");
        expect(block).not.toContain("Sources:");
    });

    it("puts the block after the summary, and alone when the summary is empty", () => {
        const methods = { templates: [], claims: [], sources: [] };
        expect(withMethodsBlock("# Results\n\n- 1 gene\n", methods)).toBe(`# Results\n\n- 1 gene\n\n---\n\n${renderMethodsBlock(methods)}\n`);
        expect(withMethodsBlock(undefined, methods)).toBe(`${renderMethodsBlock(methods)}\n`);
    });
});

// ── readStepDecisionRecords ──────────────────────────────────────────

async function stepDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "step-methods-"));
    await mkdir(join(dir, "output"), { recursive: true });
    return dir;
}

describe("readStepDecisionRecords", () => {
    it("reads each record in the order of the file names, and leaves out another file and a record that does not parse", async () => {
        const dir = await stepDir();
        const logger = createCapturingLogger();
        await writeFile(join(dir, "output", "decision_record_b.json"), JSON.stringify(record({ script_path: "/x/scripts/b.R" })));
        await writeFile(join(dir, "output", "decision_record_a.json"), JSON.stringify(record({ script_path: "/x/scripts/a.R" })));
        await writeFile(join(dir, "output", "decision_record_bad.json"), "{ not json");
        await writeFile(join(dir, "output", "decision_record_shape.json"), JSON.stringify({ template: 3 }));
        await writeFile(join(dir, "output", "summary.json"), JSON.stringify(record()));

        const records = await readStepDecisionRecords(join(dir, "output"), logger);
        expect(records.map((entry) => entry.file)).toEqual(["output/decision_record_a.json", "output/decision_record_b.json"]);
        expect(records.map((entry) => entry.record.script_path)).toEqual(["/x/scripts/a.R", "/x/scripts/b.R"]);
        const messages = logger.records.map((entry) => entry.msg);
        expect(messages.some((msg) => msg.includes("does not parse"))).toBe(true);
        expect(messages.some((msg) => msg.includes("read failed"))).toBe(true);
    });

    it("leaves out a record that is a symlink out of the step directory", async () => {
        const dir = await stepDir();
        const outside = await mkdtemp(join(tmpdir(), "step-methods-outside-"));
        await writeFile(join(outside, "secret.json"), JSON.stringify(record()));
        await symlink(join(outside, "secret.json"), join(dir, "output", "decision_record_x.json"));

        expect(await readStepDecisionRecords(join(dir, "output"), createCapturingLogger())).toEqual([]);
    });

    it("gives no record when the step has no output directory", async () => {
        const dir = await mkdtemp(join(tmpdir(), "step-methods-empty-"));
        expect(await readStepDecisionRecords(join(dir, "output"), createCapturingLogger())).toEqual([]);
    });
});

// ── restoreStepDecisionRecords ───────────────────────────────────────

describe("restoreStepDecisionRecords", () => {
    it("writes again each copy in the step that is absent or changed, leaves an equal copy, and warns for each", async () => {
        const writePrefix = await stepDir();
        const recordDir = join(writePrefix, ".host");
        await mkdir(recordDir, { recursive: true });
        const held = (name: string): string => `${JSON.stringify(record({ script_path: `/x/scripts/${name}.R` }), null, 2)}\n`;
        for (const name of ["a", "b", "c"]) await writeFile(join(recordDir, `decision_record_${name}.json`), held(name));
        await writeFile(join(writePrefix, "output", "decision_record_b.json"), JSON.stringify({ template: { id: "forged" } }));
        await writeFile(join(writePrefix, "output", "decision_record_c.json"), held("c"));
        const logger = createCapturingLogger();

        await restoreStepDecisionRecords({ recordDir, writePrefix, stagingKey: "restore", logger });

        for (const name of ["a", "b", "c"]) expect(await readFile(join(writePrefix, "output", `decision_record_${name}.json`), "utf8")).toBe(held(name));
        expect(logger.records.filter((entry) => entry.msg.includes("wrote it again")).map((entry) => entry.fields.file)).toEqual([
            "output/decision_record_a.json",
            "output/decision_record_b.json",
        ]);
    });

    it("keeps the record of a file tool that wrote the bytes, and drops a producer of other bytes", async () => {
        const writePrefix = await stepDir();
        const recordDir = join(writePrefix, ".host");
        await mkdir(recordDir, { recursive: true });
        const held = JSON.stringify(record());
        for (const name of ["a", "b"]) await writeFile(join(recordDir, `decision_record_${name}.json`), held);
        await writeFile(join(writePrefix, "output", "decision_record_a.json"), held);
        await writeFile(join(writePrefix, "output", "decision_record_b.json"), "changed by a command");
        const collector = new ProvenanceCollector({ stepId: STEP_ID, runId: RUN_ID });
        const hash = computeSha256(Buffer.from(held));
        collector.recordFileToolWrite({
            path: "output/decision_record_a.json",
            hash,
            size: held.length,
            toolName: "knowledge_template",
            invocationId: "call-1",
        });
        collector.recordCommandExecution("Rscript", ["scripts/x.R"], 0, 10, [{ path: "output/decision_record_b.json", hash: "", size: 20 }]);

        const restore = () => restoreStepDecisionRecords({ recordDir, writePrefix, stagingKey: "restore", collector, logger: createCapturingLogger() });
        await restore();
        await restore();

        expect(collector.getRecords().map((entry) => [entry.outputPath, entry.producer.type])).toEqual([["output/decision_record_a.json", "file_tool"]]);
        expect(await readFile(join(writePrefix, "output", "decision_record_b.json"), "utf8")).toBe(held);
    });

    it("writes again each host copy, also past the bound of the methods", async () => {
        const writePrefix = await stepDir();
        const recordDir = join(writePrefix, ".host");
        await mkdir(recordDir, { recursive: true });
        const names = Array.from({ length: 20 }, (_, index) => `decision_record_${String(index).padStart(2, "0")}.json`);
        for (const name of names) await writeFile(join(recordDir, name), JSON.stringify(record()));

        await restoreStepDecisionRecords({ recordDir, writePrefix, stagingKey: "restore", logger: createCapturingLogger() });

        for (const name of names) expect(await readFile(join(writePrefix, "output", name), "utf8")).toBe(JSON.stringify(record()));
    });

    it("does not follow a symlink that a command put in place of a copy, and warns", async () => {
        const writePrefix = await stepDir();
        const recordDir = join(writePrefix, ".host");
        await mkdir(recordDir, { recursive: true });
        await writeFile(join(recordDir, "decision_record_a.json"), JSON.stringify(record()));
        const outside = await mkdtemp(join(tmpdir(), "step-methods-outside-"));
        await writeFile(join(outside, "target.json"), "kept");
        await symlink(join(outside, "target.json"), join(writePrefix, "output", "decision_record_a.json"));
        const logger = createCapturingLogger();

        await restoreStepDecisionRecords({ recordDir, writePrefix, stagingKey: "restore", logger });

        expect(await readFile(join(outside, "target.json"), "utf8")).toBe("kept");
        expect(logger.records.some((entry) => entry.msg.includes("cannot write it again"))).toBe(true);
    });
});

// ── generateStepSummaryAndWrite ──────────────────────────────────────

const RUN_ID = "run-1";
const STEP_ID = "T1S2";
const AGENT_ID = "bulk-transcriptomics-agent";

const unusedPool: Querier = { query: () => Promise.reject(new Error("the summary stage wrote a row")) };

function runSession(): RunSession {
    return {
        identity: { user: "u-1" },
        scope: { kind: "analysis", analysisId: "an-1" },
        provenance: { agentId: AGENT_ID, callPath: [AGENT_ID] },
        runFrame: { runId: RUN_ID, stepId: STEP_ID },
        auth: makeLocalAuth(),
    };
}

function postCtx(writePrefix: string, grounding?: Grounding): PostStepContext {
    return {
        input: {
            analysisId: "an-1",
            runId: RUN_ID,
            stepId: STEP_ID,
            agentId: AGENT_ID,
            runSession: { ...runSession(), runFrame: { runId: RUN_ID, stepId: STEP_ID } },
            level: 0,
            prompt: "",
            grounding,
            claimViews: [view("R-0028@d560")],
        },
        session: runSession(),
        transcript: [{ role: "user", content: "Fit the model." }],
        agent: { id: AGENT_ID, systemPrompt: "You are a test step agent.", model: "test-model", tools: [], maxIterations: 4 },
        fileMetadata: createFileMetadataCell(),
        writePrefix,
        lineageCollector: new ProvenanceCollector({ stepId: STEP_ID, runId: RUN_ID }),
    };
}

function deps(provider: PostStepPipelineDeps["provider"], workspaceRoot: string): PostStepPipelineDeps {
    return {
        pool: unusedPool,
        logger: createCapturingLogger(),
        provider,
        embedding: { dimensions: 3, embed: () => errAsync({ type: "provider", retryable: false, message: "the summary stage embedded a text" }) },
        artifactRegistry: {
            register() {
                throw new Error("artifactRegistry: not driven by this test");
            },
            sync() {
                throw new Error("artifactRegistry.sync: not driven by this test");
            },
        },
        resolveWorkspaceRoot: () => Promise.resolve(workspaceRoot),
    };
}

describe("generateStepSummaryAndWrite methods", () => {
    it("appends the methods block to the summary of the agent, writes it to summary.md, and returns the methods", async () => {
        const dir = await stepDir();
        const recordDir = stepDecisionRecordDir({ workspaceRoot: dir, runId: RUN_ID, stepId: STEP_ID });
        await mkdir(recordDir, { recursive: true });
        await writeFile(join(recordDir, "decision_record_tpl-edger-ql_A.json"), JSON.stringify(record()));
        const { provider } = scriptedModel([reply([text("# Results\n\n- 1 gene at FDR 0.05")])]);

        const summary = await generateStepSummaryAndWrite(deps(provider, dir), postCtx(dir, GROUNDING), [], []);

        expect(summary?.markdown.startsWith("# Results\n\n- 1 gene at FDR 0.05\n\n---\n\n## Methods and sources")).toBe(true);
        expect(summary?.methods?.templates.map((template) => template.id)).toEqual(["tpl-edger-ql"]);
        expect(await readFile(join(dir, "output", "summary.md"), "utf8")).toBe(summary?.markdown ?? "");
    });

    it("writes the methods block alone when the summary of the agent fails", async () => {
        const dir = await stepDir();
        const { provider } = scriptedModel([]);

        const summary = await generateStepSummaryAndWrite(deps(provider, dir), postCtx(dir, GROUNDING), [], []);

        expect(summary?.markdown.startsWith(METHODS_HEADING)).toBe(true);
        expect(summary?.markdown).toContain("- R-0028@d560 (consensus): The title of R-0028@d560");
        expect(await readFile(join(dir, "output", "summary.md"), "utf8")).toBe(summary?.markdown ?? "");
    });

    it("keeps the summary of the agent as it is for a step with no grounding and no record", async () => {
        const dir = await stepDir();
        const { provider } = scriptedModel([reply([text("# Results")])]);

        const summary = await generateStepSummaryAndWrite(deps(provider, dir), postCtx(dir), [], []);

        expect(summary).toEqual({ stepId: STEP_ID, agentId: AGENT_ID, markdown: "# Results" });
    });
});
