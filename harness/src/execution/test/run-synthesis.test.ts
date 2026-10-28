/**
 * Unit tests for the harness-native run synthesizer.
 *
 * Covers three layers:
 *   1. Inner tools — `submit_synthesis` checks a synthesis and gives back the
 *      issues, `report_blocker` gives back its reason, and
 *      `acceptedSynthesisOf` selects the last accepted submission.
 *   2. `generateRunSynthesis` over a scripted model — the outcome is the last
 *      accepted synthesis with the run id of the host, else a blocker, else a
 *      throw after one salvage request.
 *   3. Disk + persistence helpers — `loadStepSummariesFromDisk` reads from
 *      the on-disk layout, `persistSynthesis` writes the JSON, and
 *      `buildRunSynthesisPart` emits the chat data part shape.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { ok, okAsync } from "neverthrow";
import { z } from "zod";

import type { LoopStep } from "../../loop/run-loop.js";
import type { ToolCallOutput } from "../../loop/tool-adapter.js";
import type { ToolOutputStore } from "../../loop/tool-output.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { RunSession } from "../../auth/types.js";
import {
    __buildInnerToolsForTest,
    pmidsIn,
    acceptedSynthesisOf,
    buildRunSynthesisPart,
    formatSynthesisEmbeddingText,
    generateRunSynthesis,
    loadStepSummariesFromDisk,
    persistSynthesis,
    readRunSynthesis,
    type GenerateRunSynthesisInput,
} from "../run-synthesis.js";
import { flattenDataPart } from "../../contracts/chat-frame.js";
import { RunSynthesisPartSchema } from "../../contracts/schemas/chat-parts.js";
import { parseJsonAs } from "../../lib/parse-json.js";
import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import type { RunSynthesis, SynthesisDraft } from "../../schemas/run-synthesis.js";
import { defineTool, type ToolContext } from "../../tools/define-tool.js";
import { synthesisAgentPrompt } from "../../prompts/synthesis-agent.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptStep } from "../../testing.js";
import { presentAt } from "../../lib/present.js";
import { awaitOk } from "../../lib/test/result-assert.js";

const RUN_ID = "run-001";

function makeRunSession(): RunSession {
    return {
        identity: { user: "user-001" },
        scope: { kind: "analysis", analysisId: "analysis-001" },
        provenance: {
            agentId: "run-synthesizer",
            callPath: ["run-synthesizer"],
        },
        runFrame: { runId: RUN_ID },
        auth: makeLocalAuth(),
    };
}

function makeToolCtx(): ToolContext {
    return {
        invocationId: "tool-call-test",
        session: makeRunSession(),
        signal: new AbortController().signal,
        emit: () => {},
    };
}

/**
 * A valid synthesis payload that satisfies both the Zod schema and the
 * semantic checks (stepId in known set, theme references match findings,
 * keyReferences cited by findings, PMIDs numeric). The model never types the
 * run id, thus the payload has none.
 */
function validSynthesisPayload(): SynthesisDraft {
    return {
        overview: "A test run analyzed gene expression in T-cells.",
        conclusions: "The analysis establishes a novel signature.",
        findings: [
            {
                stepId: "T1S1",
                title: "Upregulation of FOXP3",
                description: "FOXP3 is upregulated in stimulated cells.",
                confidence: "high",
                noveltyStatus: "confirmed",
                literatureInterpretation: "Consistent with prior reports.",
                references: [
                    {
                        pmid: "12345678",
                        citation: "Smith 2020",
                        relevance: "directly supports",
                        concordance: "supports",
                    },
                ],
            },
        ],
        themes: [
            {
                name: "Regulatory T-cell program",
                findings: [{ stepId: "T1S1", title: "Upregulation of FOXP3" }],
                narrative: "FOXP3 expression marks the regulatory program.",
            },
        ],
        limitations: ["Single cohort; n=24."],
        keyReferences: [
            {
                pmid: "12345678",
                citation: "Smith 2020",
                description: "Established FOXP3 as the master regulator.",
            },
        ],
    };
}

/** A synthesis with an unknown stepId: schema-valid, refused by the semantic checks. */
function unknownStepPayload(): SynthesisDraft {
    const bad = validSynthesisPayload();
    presentAt(bad.findings, 0).stepId = "T9S9";
    return bad;
}

const done = reply([text("done")]);

/** The PMID that the valid payload cites. */
const CITED_PMID = "12345678";

/** A PubMed lookup that returns the cited PMID. */
const pubmedLookup = defineTool({
    id: "pubmed",
    description: "Search PubMed.",
    inputSchema: z.object({ query: z.string() }),
    describeCall: "none",
    execute: () => Promise.resolve(ok({ totalFound: 1, results: [{ pmid: CITED_PMID, title: "FOXP3 in regulatory T cells" }] })),
});

const lookup = (id: string) => callTools(toolCall(id, "pubmed", { query: "FOXP3 regulatory T cells" }));

const submit = (id: string, synthesis: unknown) => callTools(toolCall(id, "submit_synthesis", { synthesis }));

/** Run the synthesizer over a scripted model, with one summary of the step T1S1. */
function synthesize(script: readonly ScriptStep[], extra: Partial<GenerateRunSynthesisInput> = {}) {
    const model = scriptedModel(script);
    const run = generateRunSynthesis({
        provider: model.provider,
        session: makeRunSession(),
        model: "claude-test",
        synthesisLookups: [pubmedLookup],
        summaries: [{ stepId: "T1S1", agentId: "bulk-transcriptomics-agent", markdown: "## results" }],
        planNarrative: "Compare stimulated vs resting T-cells.",
        runId: RUN_ID,
        ...extra,
    });
    return { run, calls: model.calls };
}

const toolNamesOf = (call: LanguageModelV4CallOptions): string[] => (call.tools ?? []).map((tool) => tool.name);

/** The output of the result of one tool call, as the request sent it to the model. */
function toolResultIn(call: LanguageModelV4CallOptions, toolCallId: string): unknown {
    for (const message of call.prompt) {
        if (message.role !== "tool") continue;
        for (const part of message.content) {
            if (part.type === "tool-result" && part.toolCallId === toolCallId) return part.output;
        }
    }
    return undefined;
}

/** The text of the last user message of a request. */
function lastUserText(call: LanguageModelV4CallOptions): string {
    const user = call.prompt.filter((message) => message.role === "user").at(-1);
    if (user?.role !== "user") return "";
    return user.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** One recorded call of `submit_synthesis`, with the result that the tool gave. */
function submitCall(toolCallId: string, synthesis: unknown, value: Extract<ToolCallOutput, { outcome: "ok" }>["value"]): LoopStep["calls"][number] {
    return {
        toolCallId,
        toolName: "submit_synthesis",
        input: { synthesis },
        output: { outcome: "ok", value },
        refused: false,
        answered: true,
    };
}

describe("submit_synthesis inner tool", () => {
    it("accepts a valid synthesis whose PMIDs a lookup returned", async () => {
        const { submit: tool } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]), lookedUpPmids: new Set([CITED_PMID]) });

        const result = (await tool.execute({ synthesis: validSynthesisPayload() }, makeToolCtx()))._unsafeUnwrap();

        expect(result).toEqual({ accepted: true });
    });

    it("declares no run id in its input schema", () => {
        const { submit: tool } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]) });

        const schema = z.object({ properties: z.object({ synthesis: z.object({ properties: z.record(z.string(), z.json()) }) }) }).parse(tool.jsonSchema);

        expect(Object.keys(schema.properties.synthesis.properties)).not.toContain("runId");
        expect(Object.keys(schema.properties.synthesis.properties)).toContain("overview");
    });

    it("rejects a payload with an unknown stepId", async () => {
        const { submit: tool } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]) });

        const result = (await tool.execute({ synthesis: unknownStepPayload() }, makeToolCtx()))._unsafeUnwrap();

        if (!("issues" in result)) throw new Error("expected a rejected submission");
        expect(result.accepted).toBe(false);
        expect(result.issues.some((i) => i.code === "semantic" && i.message.includes("T9S9"))).toBe(true);
    });

    it("rejects a non-numeric PMID", async () => {
        const { submit: tool } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]) });
        const bad = validSynthesisPayload();
        presentAt(presentAt(bad.findings, 0).references, 0).pmid = "PMC123";
        presentAt(bad.keyReferences, 0).pmid = "PMC123";

        const result = (await tool.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap();

        if (!("issues" in result)) throw new Error("expected a rejected submission");
        expect(result.accepted).toBe(false);
        expect(result.issues.some((i) => i.path.includes("pmid"))).toBe(true);
    });

    it("reports every semantic issue, in the order of the checks", async () => {
        const { submit: tool } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]) });
        const bad = unknownStepPayload();
        presentAt(presentAt(bad.findings, 0).references, 0).pmid = "PMC1";
        presentAt(bad.keyReferences, 0).pmid = "PMC2";

        const result = (await tool.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap();

        if (!("issues" in result)) throw new Error("expected a rejected submission");
        expect(result.issues.every((i) => i.code === "semantic")).toBe(true);
        expect(result.issues.map((i) => i.path)).toEqual([
            "synthesis.findings[0].stepId",
            "synthesis.themes[0].findings[0]",
            "synthesis.keyReferences[0].pmid",
            "synthesis.findings[0].references[0].pmid",
            "synthesis.keyReferences[0].pmid",
        ]);
    });

    it("refuses a numeric PMID that no lookup of the run returned", async () => {
        const { submit: tool } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]), lookedUpPmids: new Set(["99999999"]) });

        const result = (await tool.execute({ synthesis: validSynthesisPayload() }, makeToolCtx()))._unsafeUnwrap();

        if (!("issues" in result)) throw new Error("expected a rejected submission");
        expect(result.issues.map((i) => [i.path, i.message])).toEqual([
            ["synthesis.findings[0].references[0].pmid", `pmid "${CITED_PMID}" is in no lookup result of this run`],
            ["synthesis.keyReferences[0].pmid", `pmid "${CITED_PMID}" is in no lookup result of this run`],
        ]);
    });

    it("refuses a malformed synthesis at its input schema", () => {
        const { submit: tool } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]) });

        expect(tool.inputSchema.safeParse({ synthesis: { overview: 42, findings: "not an array" } }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ synthesis: validSynthesisPayload() }).success).toBe(true);
    });
});

describe("acceptedSynthesisOf", () => {
    it("takes the last accepted submission, and a later refused one does not replace it", () => {
        const first = validSynthesisPayload();
        const revised = { ...validSynthesisPayload(), overview: "The revised, real synthesis of the run." };
        const refused = { accepted: false, issues: [{ path: "synthesis.findings[0].stepId", code: "semantic", message: "unknown" }] };

        const steps: LoopStep[] = [
            { finishReason: "tool-calls", calls: [submitCall("s1", first, { accepted: true })] },
            { finishReason: "tool-calls", calls: [submitCall("s2", unknownStepPayload(), refused)] },
        ];
        expect(acceptedSynthesisOf(steps)).toEqual(first);

        steps.push({ finishReason: "tool-calls", calls: [submitCall("s3", revised, { accepted: true })] });
        expect(acceptedSynthesisOf(steps)).toEqual(revised);
    });

    it("gives nothing for a run with no accepted submission", () => {
        const refused = { accepted: false, issues: [] };
        expect(acceptedSynthesisOf([{ finishReason: "tool-calls", calls: [submitCall("s1", unknownStepPayload(), refused)] }])).toBeUndefined();
        expect(acceptedSynthesisOf([])).toBeUndefined();
    });
});

describe("report_blocker inner tool", () => {
    it("gives back the reason of the blocker", async () => {
        const { blocker } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]) });

        const result = await awaitOk(blocker.execute({ reason: "no synthesizable content" }, makeToolCtx()));

        expect(result).toMatchObject({ kind: "blocker", reason: "no synthesizable content" });
    });

    it("refuses a placeholder reason at its input schema", () => {
        const { blocker } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]) });

        expect(blocker.inputSchema.safeParse({ reason: "TBD" }).success).toBe(false);
        expect(blocker.inputSchema.safeParse({ reason: "Placeholder, not used" }).success).toBe(false);
        expect(blocker.inputSchema.safeParse({ reason: "Every step summary is empty." }).success).toBe(true);
    });
});

describe("generateRunSynthesis", () => {
    it("drives the agent loop to submit_synthesis and returns the accepted synthesis", async () => {
        const { run, calls } = synthesize([lookup("lk-1"), submit("tu-1", validSynthesisPayload()), done]);

        const result = await run;

        expect(result).toEqual({ kind: "synthesis", synthesis: { runId: RUN_ID, ...validSynthesisPayload() } });
        // The submit does not end the run: the model reads the result, and its reply ends the run.
        expect(calls).toHaveLength(3);
    });

    it("stamps the run id of its own run, whatever run id the model typed", async () => {
        const { run } = synthesize([lookup("lk-1"), submit("tu-1", { ...validSynthesisPayload(), runId: "run-typed-by-the-model" }), done]);

        const result = await run;

        if (result.kind !== "synthesis") throw new Error("expected a synthesis");
        expect(result.synthesis.runId).toBe(RUN_ID);
    });

    it("declares the synthesis tools, the lookups, and then read_tool_output when it has a tool output store", async () => {
        const toolOutputStore: ToolOutputStore = { put: () => okAsync(undefined), get: () => okAsync(null) };
        const { run, calls } = synthesize([lookup("lk-1"), submit("tu-1", validSynthesisPayload()), done], { toolOutputStore });

        await run;

        expect(toolNamesOf(presentAt(calls, 0))).toEqual(["submit_synthesis", "report_blocker", "pubmed", "read_tool_output"]);
    });

    it("returns skipped with the reason when the agent records only a blocker", async () => {
        const { run, calls } = synthesize([callTools(toolCall("tu-1", "report_blocker", { reason: "all summaries are empty" })), done]);

        const result = await run;

        expect(result).toEqual({ kind: "skipped", reason: "all summaries are empty" });
        // A blocker is an outcome, thus no salvage request follows.
        expect(calls).toHaveLength(2);
    });

    it("keeps an accepted synthesis over a blocker of the same run", async () => {
        const { run } = synthesize([
            lookup("lk-1"),
            callTools(
                toolCall("tu-1", "report_blocker", { reason: "nothing to synthesize" }),
                toolCall("tu-2", "submit_synthesis", { synthesis: validSynthesisPayload() }),
            ),
            done,
        ]);

        const result = await run;

        expect(result.kind).toBe("synthesis");
    });

    it("gives a refused synthesis its issues, and the corrected submission is the synthesis", async () => {
        const { run, calls } = synthesize([lookup("lk-1"), submit("tu-1", unknownStepPayload()), submit("tu-2", validSynthesisPayload()), done]);

        const result = await run;

        expect(result).toEqual({ kind: "synthesis", synthesis: { runId: RUN_ID, ...validSynthesisPayload() } });
        const refused = z
            .object({ type: z.literal("json"), value: z.object({ accepted: z.literal(false), issues: z.array(z.object({ path: z.string() })) }) })
            .parse(toolResultIn(presentAt(calls, 2), "tu-1"));
        expect(refused.value.issues.map((issue) => issue.path)).toContain("synthesis.findings[0].stepId");
    });

    it("accepts a synthesis that arrives as a JSON-encoded string", async () => {
        const { run } = synthesize([lookup("lk-1"), submit("tu-1", JSON.stringify(validSynthesisPayload())), done]);

        const result = await run;

        expect(result).toEqual({ kind: "synthesis", synthesis: { runId: RUN_ID, ...validSynthesisPayload() } });
    });

    it("salvages a run that ends on prose, and the salvage lets only the terminal tools run", async () => {
        const { run, calls } = synthesize([lookup("lk-1"), reply([text("thinking out loud")]), lookup("lk-2"), submit("tu-1", validSynthesisPayload()), done]);

        const result = await run;

        expect(result.kind).toBe("synthesis");
        expect(lastUserText(presentAt(calls, 2))).toContain("You ended without an accepted synthesis");
        expect(toolResultIn(presentAt(calls, 3), "lk-2")).toEqual({
            type: "error-text",
            value: JSON.stringify({
                error: "The tool pubmed is not available for this request, thus it did not run. The tools that can run now: submit_synthesis, report_blocker.",
                retryable: false,
            }),
        });
    });

    it("throws when the run and its salvage both end with no outcome", async () => {
        const prose = reply([text("just thinking out loud")]);
        const { run, calls } = synthesize([prose, prose]);

        await expect(run).rejects.toThrow("terminal tool call");

        // One salvage request followed the run, and no request followed the salvage.
        expect(calls).toHaveLength(2);
        expect(lastUserText(presentAt(calls, 1))).toContain("You ended without an accepted synthesis");
    });

    it("refuses a PMID that no lookup returned, and accepts it after the lookup", async () => {
        const { run, calls } = synthesize([submit("tu-1", validSynthesisPayload()), lookup("lk-1"), submit("tu-2", validSynthesisPayload()), done]);

        const result = await run;

        expect(result).toEqual({ kind: "synthesis", synthesis: { runId: RUN_ID, ...validSynthesisPayload() } });
        const refused = z
            .object({ value: z.object({ accepted: z.literal(false), issues: z.array(z.object({ path: z.string(), message: z.string() })) }) })
            .parse(toolResultIn(presentAt(calls, 1), "tu-1"));
        expect(refused.value.issues.map((issue) => issue.message)).toEqual([
            `pmid "${CITED_PMID}" is in no lookup result of this run`,
            `pmid "${CITED_PMID}" is in no lookup result of this run`,
        ]);
    });

    it("throws on empty summaries", async () => {
        const { run } = synthesize([], { summaries: [] });

        await expect(run).rejects.toThrow("no step summaries");
    });
});

describe("pmidsIn", () => {
    it("reads pmid and pmids keys at any depth", () => {
        const found = pmidsIn({ results: [{ pmid: "111" }, { pmid: 222 }], phenotypes: [{ pmids: ["333", "not-a-pmid"] }], notFound: ["444"] });
        expect([...found].sort()).toEqual(["111", "222", "333"]);
    });

    it("skips the request that a lookup gives back, thus an invented PMID that was only checked does not count", () => {
        const resolution = {
            input: { citation: "PMID 99999999" },
            normalized: { identifiers: { pmid: "99999999" } },
            sourceOutcomes: [{ records: [{ identifiers: { pmid: "12345678" } }] }],
        };
        expect([...pmidsIn(resolution)]).toEqual(["12345678"]);
    });
});

describe("blocker discipline copy", () => {
    it("scopes the blocker tool description to empty/incoherent inputs, not 'no findings worth surfacing'", () => {
        const { blocker } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]) });
        expect(blocker.description.toLowerCase()).not.toContain("worth surfacing");
        expect(blocker.description).toContain("empty findings[]");
        expect(blocker.description.toLowerCase()).toContain("incoheren");
    });

    it("synthesizer prompt states an empty findings[] is a valid submission and not a blocker", () => {
        expect(synthesisAgentPrompt).toContain("is a valid submission");
        expect(synthesisAgentPrompt).toContain("never a reason to `report_blocker`");
    });
});

describe("loadStepSummariesFromDisk", () => {
    let tempDir = "";
    beforeAll(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "cortex-synthesis-"));
        const stepDir = join(tempDir, "analysis-001", "runs", RUN_ID, "T1S1", "output");
        await mkdir(stepDir, { recursive: true });
        await writeFile(join(stepDir, "summary.md"), "## step one\n\nresults.");
        // Empty summary that should be filtered out:
        const emptyStepDir = join(tempDir, "analysis-001", "runs", RUN_ID, "T1S2", "output");
        await mkdir(emptyStepDir, { recursive: true });
        await writeFile(join(emptyStepDir, "summary.md"), "   \n");
    });
    afterAll(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    it("reads non-empty summaries and skips missing/empty ones", async () => {
        const out = await loadStepSummariesFromDisk({
            workspaceRoot: join(tempDir, "analysis-001"),
            runId: RUN_ID,
            completedSteps: ["T1S1", "T1S2", "T1S3-missing"],
        });
        expect(out).toHaveLength(1);
        expect(presentAt(out, 0).stepId).toBe("T1S1");
        expect(presentAt(out, 0).markdown).toContain("step one");
    });
});

describe("persistSynthesis", () => {
    it("writes synthesis.json under the run directory", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "cortex-synthesis-"));
        try {
            const synthesis = {
                runId: RUN_ID,
                overview: "ov",
                conclusions: "cl",
                findings: [],
                themes: [],
                limitations: [],
                keyReferences: [],
            };
            const path = await persistSynthesis({
                workspaceRoot: join(tempDir, "analysis-001"),
                runId: RUN_ID,
                synthesis,
            });
            expect(path.endsWith("synthesis.json")).toBe(true);
            const written = parseUnknownRecord(parseJsonAs(await readFile(path, "utf8"), z.json()));
            expect(written?.runId).toBe(RUN_ID);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });
});

describe("buildRunSynthesisPart + formatSynthesisEmbeddingText", () => {
    it("emits a data-run-synthesis chat part with the synthesis fields", () => {
        const synthesis = {
            runId: RUN_ID,
            overview: "ov",
            conclusions: "cl",
            findings: [],
            themes: [],
            limitations: [],
            keyReferences: [],
        };
        const part = buildRunSynthesisPart(RUN_ID, synthesis);
        expect(part.type).toBe("data-run-synthesis");
        const data = parseUnknownRecord(part.data);
        expect(data?.id).toBe(`synthesis-${RUN_ID}`);
        expect(data?.runId).toBe(RUN_ID);
    });

    it("formats the embedding text with the expected sections", () => {
        const text = formatSynthesisEmbeddingText({
            runId: RUN_ID,
            overview: "ov",
            conclusions: "cl",
            findings: [],
            themes: [],
            limitations: ["lim1"],
            keyReferences: [{ pmid: "1", citation: "c1", description: "d1" }],
        });
        expect(text).toContain("# Overview");
        expect(text).toContain("# Conclusions");
        expect(text).toContain("# Limitations");
        expect(text).toContain("# Key References");
        expect(text).toContain("PMID:1");
    });
});

describe("readRunSynthesis", () => {
    let root: string;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "cortex-read-synthesis-"));
    });
    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const synthesis: RunSynthesis = {
        runId: RUN_ID,
        overview: "ov",
        conclusions: "cl",
        findings: [
            {
                stepId: "A",
                title: "Upregulation of FOXP3",
                description: "FOXP3 is upregulated.",
                confidence: "high",
                noveltyStatus: "confirmed",
                literatureInterpretation: "Consistent with prior reports.",
                references: [{ pmid: "12345678", citation: "Smith 2020", relevance: "directly supports", concordance: "supports" }],
                translationalRelevance: { stage: "discovery", rationale: "No clinical path yet." },
            },
        ],
        themes: [],
        limitations: ["Single cohort."],
        keyReferences: [{ pmid: "12345678", citation: "Smith 2020", description: "Established FOXP3." }],
    };

    async function writeRecord(runId: string, text: string): Promise<void> {
        const dir = join(root, "runs", runId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "synthesis.json"), text, "utf8");
    }

    it("gives the part that the synthesis sink writes for the same record, and the part passes RunSynthesisPartSchema", async () => {
        await persistSynthesis({ workspaceRoot: root, runId: RUN_ID, synthesis });

        const part = await readRunSynthesis({ workspaceRoot: root, runId: RUN_ID });

        if (part === null) throw new Error("the synthesis record is on disk, so the read gives the part");
        expect(flattenDataPart(buildRunSynthesisPart(RUN_ID, synthesis))).toEqual(part);
        expect(part).toMatchObject({ type: "data-run-synthesis", id: `synthesis-${RUN_ID}` });
        expect(RunSynthesisPartSchema.safeParse(part).success).toBe(true);
        expect(part.findings[0]?.references).toEqual(presentAt(synthesis.findings, 0).references);
    });

    it("gives null when no record is on disk", async () => {
        expect(await readRunSynthesis({ workspaceRoot: root, runId: "run-absent" })).toBeNull();
    });

    it("gives null for a record whose findings have no references", async () => {
        const finding = { ...presentAt(synthesis.findings, 0, "the first finding"), references: undefined };
        await writeRecord("run-no-refs", JSON.stringify({ ...synthesis, runId: "run-no-refs", findings: [finding] }));

        expect(await readRunSynthesis({ workspaceRoot: root, runId: "run-no-refs" })).toBeNull();
    });

    it("gives null for a record over the cap", async () => {
        await writeRecord("run-huge", JSON.stringify({ ...synthesis, runId: "run-huge", overview: "x".repeat(1024 * 1024 + 64) }));

        expect(await readRunSynthesis({ workspaceRoot: root, runId: "run-huge" })).toBeNull();
    });

    it("gives null for text that is not JSON", async () => {
        await writeRecord("run-garbage", "{ not json");

        expect(await readRunSynthesis({ workspaceRoot: root, runId: "run-garbage" })).toBeNull();
    });

    it("gives null for a run id that can escape the run tree", async () => {
        expect(await readRunSynthesis({ workspaceRoot: root, runId: "../run-001" })).toBeNull();
    });
});
