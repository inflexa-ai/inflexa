/**
 * Unit tests for the harness-native run synthesizer.
 *
 * Covers three layers:
 *   1. Inner-tool validation — `submit_synthesis` accepts a valid payload,
 *      rejects schema + semantic violations, and idempotently captures the
 *      outcome.
 *   2. Happy path through `generateRunSynthesis` — the synthesizer agent
 *      reaches a `submit_synthesis(accepted: true)` via the scripted provider
 *      and the function returns the validated synthesis.
 *   3. Disk + persistence helpers — `loadStepSummariesFromDisk` reads from
 *      the on-disk layout, `persistSynthesis` writes the JSON, and
 *      `buildRunSynthesisPart` emits the chat data part shape.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "../loop/__fixtures__/scripted-provider.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { RunSession } from "../auth/types.js";
import {
    __buildInnerToolsForTest,
    buildRunSynthesisPart,
    formatSynthesisEmbeddingText,
    generateRunSynthesis,
    loadStepSummariesFromDisk,
    persistSynthesis,
} from "./run-synthesis.js";
import type { ToolContext } from "../tools/define-tool.js";

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
        session: makeRunSession(),
        signal: new AbortController().signal,
        emit: () => {},
        runStep: (_name, fn) => fn(),
    };
}

/**
 * A valid synthesis payload that satisfies both the Zod schema and the
 * semantic checks (stepId in known set, theme references match findings,
 * keyReferences cited by findings, PMIDs numeric).
 */
function validSynthesisPayload(): unknown {
    return {
        runId: RUN_ID,
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

describe("submit_synthesis inner tool", () => {
    it("accepts a valid payload and captures the outcome", async () => {
        const { submit, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });

        const result = (await submit.execute({ synthesis: validSynthesisPayload() }, makeToolCtx()))._unsafeUnwrap() as { accepted: true };

        expect(result.accepted).toBe(true);
        expect(holder.outcome?.kind).toBe("submitted");
        if (holder.outcome?.kind === "submitted") {
            expect(holder.outcome.synthesis.runId).toBe(RUN_ID);
            expect(holder.outcome.synthesis.findings).toHaveLength(1);
        }
    });

    it("rejects a payload with an unknown stepId", async () => {
        const { submit, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });

        const bad = validSynthesisPayload() as { findings: { stepId: string }[] };
        bad.findings[0]!.stepId = "T9S9";

        const result = (await submit.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap() as {
            accepted: false;
            issues: { path: string; code: string }[];
        };

        expect(result.accepted).toBe(false);
        expect(result.issues.some((i) => i.code === "semantic")).toBe(true);
        expect(holder.outcome).toBeNull();
    });

    it("rejects a non-numeric PMID", async () => {
        const { submit } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });
        const bad = validSynthesisPayload() as {
            findings: { references: { pmid: string }[] }[];
            keyReferences: { pmid: string }[];
        };
        bad.findings[0]!.references[0]!.pmid = "PMC123";
        bad.keyReferences[0]!.pmid = "PMC123";

        const result = (await submit.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap() as {
            accepted: false;
            issues: { path: string }[];
        };

        expect(result.accepted).toBe(false);
        expect(result.issues.some((i) => i.path.includes("pmid"))).toBe(true);
    });

    it("rejects a second call after success", async () => {
        const { submit, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });
        await submit.execute({ synthesis: validSynthesisPayload() }, makeToolCtx());
        const second = (await submit.execute({ synthesis: validSynthesisPayload() }, makeToolCtx()))._unsafeUnwrap() as {
            accepted: false;
            issues: { message: string }[];
        };
        expect(second.accepted).toBe(false);
        expect(second.issues[0]!.message).toMatch(/already been recorded/);
        expect(holder.outcome?.kind).toBe("submitted");
    });
});

describe("report_blocker inner tool", () => {
    it("captures a blocker outcome", async () => {
        const { blocker, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });
        const result = (await blocker.execute({ reason: "no synthesizable content" }, makeToolCtx()))._unsafeUnwrap() as { recorded: true };
        expect(result.recorded).toBe(true);
        expect(holder.outcome?.kind).toBe("blocker");
        if (holder.outcome?.kind === "blocker") {
            expect(holder.outcome.reason).toBe("no synthesizable content");
        }
    });
});

describe("generateRunSynthesis — happy path", () => {
    it("drives the agent loop to submit_synthesis and returns the validated synthesis", async () => {
        // Script: turn 1 → submit_synthesis with the valid payload; submit_tool
        // returns accepted:true; turn 2 → terminal end_turn message.
        const provider = scriptedProvider((i) => {
            if (i === 0) {
                return makeMessage(
                    [
                        toolUseBlock("tu-1", "submit_synthesis", {
                            synthesis: validSynthesisPayload(),
                        }),
                    ],
                    "tool_use",
                );
            }
            return makeMessage([textBlock("done")], "end_turn");
        });

        const emitted: unknown[] = [];
        const result = await generateRunSynthesis({
            provider,
            session: makeRunSession(),
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            summaries: [{ stepId: "T1S1", agentId: "bulk-transcriptomics-agent", markdown: "## results" }],
            planNarrative: "Compare stimulated vs resting T-cells.",
            runId: RUN_ID,
            emit: (e) => {
                emitted.push(e);
            },
        });

        expect(result.kind).toBe("synthesis");
        if (result.kind === "synthesis") {
            expect(result.synthesis.runId).toBe(RUN_ID);
            expect(result.synthesis.findings).toHaveLength(1);
            expect(result.synthesis.findings[0]!.title).toBe("Upregulation of FOXP3");
        }
    });

    it("returns skipped when the agent calls report_blocker", async () => {
        const provider = scriptedProvider((i) => {
            if (i === 0) {
                return makeMessage(
                    [
                        toolUseBlock("tu-1", "report_blocker", {
                            reason: "all summaries are empty",
                        }),
                    ],
                    "tool_use",
                );
            }
            return makeMessage([textBlock("done")], "end_turn");
        });

        const result = await generateRunSynthesis({
            provider,
            session: makeRunSession(),
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            summaries: [{ stepId: "T1S1", agentId: "bulk-transcriptomics-agent", markdown: "noop" }],
            planNarrative: "n/a",
            runId: RUN_ID,
        });

        expect(result.kind).toBe("skipped");
        if (result.kind === "skipped") {
            expect(result.reason).toBe("all summaries are empty");
        }
    });

    it("re-prompts once then throws when the agent never calls a terminal tool", async () => {
        // Provider replies with plain text only — no submit_synthesis, no
        // report_blocker. After the first runAgent ends on prose, the corrective
        // continuation fires; the agent still produces no terminal tool →
        // `generateRunSynthesis` throws.
        const provider = scriptedProvider(() => makeMessage([textBlock("just thinking out loud")], "end_turn"));
        await expect(
            generateRunSynthesis({
                provider,
                session: makeRunSession(),
                model: "claude-test",
                bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
                summaries: [{ stepId: "T1S1", agentId: "bulk-transcriptomics-agent", markdown: "x" }],
                planNarrative: "n/a",
                runId: RUN_ID,
            }),
        ).rejects.toThrow(/terminal tool call/);

        // The corrective continuation re-prompted: a later chat request carries a
        // user turn instructing a terminal-tool call.
        const reprompted = provider.calls.some((c) =>
            c.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("ended without calling a terminal tool")),
        );
        expect(reprompted).toBe(true);
    });

    it("recovers via the corrective re-prompt when the second pass submits", async () => {
        // First runAgent ends on prose (no terminal tool). The corrective
        // continuation then drives submit_synthesis → returns the synthesis.
        let sawReprompt = false;
        const provider = scriptedProvider((_i, request) => {
            const last = request.messages.at(-1);
            const repromptTurn = last?.role === "user" && typeof last.content === "string" && last.content.includes("ended without calling a terminal tool");
            if (repromptTurn) {
                sawReprompt = true;
                return makeMessage(
                    [
                        toolUseBlock("tu-1", "submit_synthesis", {
                            synthesis: validSynthesisPayload(),
                        }),
                    ],
                    "tool_use",
                );
            }
            return makeMessage([textBlock("thinking out loud")], "end_turn");
        });

        const result = await generateRunSynthesis({
            provider,
            session: makeRunSession(),
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            summaries: [{ stepId: "T1S1", agentId: "bulk-transcriptomics-agent", markdown: "x" }],
            planNarrative: "n/a",
            runId: RUN_ID,
        });

        expect(sawReprompt).toBe(true);
        expect(result.kind).toBe("synthesis");
        if (result.kind === "synthesis") {
            expect(result.synthesis.runId).toBe(RUN_ID);
        }
    });

    it("throws on empty summaries", async () => {
        const provider = scriptedProvider([]);
        await expect(
            generateRunSynthesis({
                provider,
                session: makeRunSession(),
                model: "claude-test",
                bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
                summaries: [],
                planNarrative: "n/a",
                runId: RUN_ID,
            }),
        ).rejects.toThrow(/no step summaries/);
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
            sessionsBasePath: tempDir,
            analysisId: "analysis-001",
            runId: RUN_ID,
            completedSteps: ["T1S1", "T1S2", "T1S3-missing"],
        });
        expect(out).toHaveLength(1);
        expect(out[0]!.stepId).toBe("T1S1");
        expect(out[0]!.markdown).toContain("step one");
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
                sessionsBasePath: tempDir,
                analysisId: "analysis-001",
                runId: RUN_ID,
                synthesis,
            });
            expect(path.endsWith("synthesis.json")).toBe(true);
            const written = JSON.parse(await readFile(path, "utf8")) as {
                runId: string;
            };
            expect(written.runId).toBe(RUN_ID);
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
        const data = part.data as { id: string; runId: string };
        expect(data.id).toBe(`synthesis-${RUN_ID}`);
        expect(data.runId).toBe(RUN_ID);
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
