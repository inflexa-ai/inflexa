/**
 * Unit tests for the harness-native run synthesizer.
 *
 * Covers three layers:
 *   1. Inner-tool validation — `validate_synthesis` reports issues without
 *      recording anything, and `submit_synthesis` accepts a valid payload,
 *      rejects schema + semantic violations, and captures the outcome
 *      last-valid-wins.
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
import { synthesisAgentPrompt } from "../prompts/synthesis-agent.js";

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

    it("does not clobber a recorded outcome when a later submission is invalid", async () => {
        const { submit, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });
        await submit.execute({ synthesis: validSynthesisPayload() }, makeToolCtx());

        const bad = validSynthesisPayload() as { findings: { stepId: string }[]; overview: string };
        bad.findings[0]!.stepId = "T9S9";
        bad.overview = "clobbered";

        const second = (await submit.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap() as {
            accepted: false;
            issues: { code: string }[];
        };

        expect(second.accepted).toBe(false);
        expect(second.issues.some((i) => i.code === "semantic")).toBe(true);
        expect(holder.outcome?.kind).toBe("submitted");
        if (holder.outcome?.kind === "submitted") {
            expect(holder.outcome.synthesis.overview).toBe((validSynthesisPayload() as { overview: string }).overview);
        }
    });

    it("overwrites an earlier outcome when a later submission is valid", async () => {
        const { submit, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });
        await submit.execute({ synthesis: validSynthesisPayload() }, makeToolCtx());

        const revised = validSynthesisPayload() as { overview: string };
        revised.overview = "The revised, real synthesis of the run.";

        const second = (await submit.execute({ synthesis: revised }, makeToolCtx()))._unsafeUnwrap() as { accepted: true };

        expect(second.accepted).toBe(true);
        expect(holder.outcome?.kind).toBe("submitted");
        if (holder.outcome?.kind === "submitted") {
            expect(holder.outcome.synthesis.overview).toBe("The revised, real synthesis of the run.");
        }
    });

    it("overwrites a recorded blocker outcome", async () => {
        const { submit, blocker, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });
        await blocker.execute({ reason: "nothing to synthesize" }, makeToolCtx());
        expect(holder.outcome?.kind).toBe("blocker");

        const result = (await submit.execute({ synthesis: validSynthesisPayload() }, makeToolCtx()))._unsafeUnwrap() as { accepted: true };

        expect(result.accepted).toBe(true);
        expect(holder.outcome?.kind).toBe("submitted");
    });
});

describe("validate_synthesis inner tool", () => {
    it("accepts a valid candidate without recording an outcome", async () => {
        const { validate, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });

        const result = (await validate.execute({ synthesis: validSynthesisPayload() }, makeToolCtx()))._unsafeUnwrap() as {
            valid: true;
            issues: unknown[];
        };

        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
        expect(holder.outcome).toBeNull();
    });

    it("reports schema issues on a malformed candidate instead of rejecting it", async () => {
        const { validate, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });

        const result = (await validate.execute({ synthesis: { overview: 42, findings: "not an array" } }, makeToolCtx()))._unsafeUnwrap() as {
            valid: false;
            issues: { path: string; code: string; message: string }[];
        };

        expect(result.valid).toBe(false);
        expect(result.issues.length).toBeGreaterThan(0);
        // Nothing in this candidate is salvageable, so every field-level issue is
        // a schema issue; the only semantic entry is the deferred-checks notice.
        expect(result.issues.filter((i) => i.path !== "synthesis").every((i) => i.code === "schema")).toBe(true);
        expect(result.issues.some((i) => i.path === "synthesis" && i.message.includes("INCOMPLETE"))).toBe(true);
        expect(holder.outcome).toBeNull();
    });

    it("reports a schema issue and a semantic PMID issue in one pass", async () => {
        const { validate, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });

        const bad = validSynthesisPayload() as {
            conclusions?: string;
            findings: { references: { pmid: string }[] }[];
        };
        delete bad.conclusions;
        bad.findings[0]!.references[0]!.pmid = "PMC123";

        const result = (await validate.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap() as {
            valid: false;
            issues: { path: string; code: string; message: string }[];
        };

        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.code === "schema" && i.path === "synthesis.conclusions")).toBe(true);
        expect(result.issues.some((i) => i.code === "semantic" && i.path === "synthesis.findings[0].references[0].pmid")).toBe(true);
        // keyReferences[0].pmid is no longer cited by any finding either.
        expect(result.issues.some((i) => i.code === "semantic" && i.path === "synthesis.keyReferences[0].pmid")).toBe(true);
        // Every check's inputs survived — nothing was deferred.
        expect(result.issues.some((i) => i.message.includes("INCOMPLETE"))).toBe(false);
        // Structure before content.
        const codes = result.issues.map((i) => i.code);
        const lastSchema = codes.lastIndexOf("schema");
        const firstSemantic = codes.indexOf("semantic");
        expect(lastSchema).toBeLessThan(firstSemantic);
        expect(holder.outcome).toBeNull();
    });

    it("reports a schema issue and an unknown stepId in one pass", async () => {
        const { validate } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });

        const bad = validSynthesisPayload() as {
            overview?: string;
            findings: { stepId: string }[];
        };
        delete bad.overview;
        bad.findings[0]!.stepId = "T9S9";

        const result = (await validate.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap() as {
            valid: false;
            issues: { path: string; code: string; message: string }[];
        };

        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.code === "schema" && i.path === "synthesis.overview")).toBe(true);
        const stepIdIssue = result.issues.find((i) => i.path === "synthesis.findings[0].stepId");
        expect(stepIdIssue?.code).toBe("semantic");
        expect(stepIdIssue?.message).toContain("T9S9");
        // The theme still references the finding by its old stepId — also caught.
        expect(result.issues.some((i) => i.path === "synthesis.themes[0].findings[0]")).toBe(true);
        expect(result.issues.some((i) => i.message.includes("INCOMPLETE"))).toBe(false);
    });

    it("names the deferred checks when findings cannot be salvaged", async () => {
        const { validate } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });

        const bad = validSynthesisPayload() as { findings: unknown; keyReferences: { pmid: string }[] };
        bad.findings = [{ stepId: 7 }];
        bad.keyReferences[0]!.pmid = "PMC999";

        const result = (await validate.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap() as {
            valid: false;
            issues: { path: string; code: string; message: string }[];
        };

        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.code === "schema" && i.path.startsWith("synthesis.findings."))).toBe(true);
        // runId + keyReferences PMID format still parsed on their own, so their
        // checks ran: the malformed PMID is reported.
        expect(result.issues.some((i) => i.code === "semantic" && i.path === "synthesis.keyReferences[0].pmid")).toBe(true);

        const notice = result.issues.find((i) => i.path === "synthesis" && i.message.includes("INCOMPLETE"));
        expect(notice).toBeDefined();
        expect(notice?.code).toBe("semantic");
        expect(notice?.message).toContain("finding stepIds");
        expect(notice?.message).toContain("theme references");
        expect(notice?.message).toContain("cited by some finding");
        expect(notice?.message).toContain("finding reference PMIDs are numeric");
        // runId and the keyReferences PMID-format check were NOT deferred.
        expect(notice?.message).not.toContain("runId matches the run");
        expect(notice?.message).not.toContain("keyReferences PMIDs are numeric");
        expect(notice?.hint).toBeDefined();
    });

    it("reports every semantic issue on a schema-valid candidate, unchanged", async () => {
        const { validate, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });

        const bad = validSynthesisPayload() as {
            runId: string;
            findings: { stepId: string; references: { pmid: string }[] }[];
            keyReferences: { pmid: string }[];
        };
        bad.runId = "run-999";
        bad.findings[0]!.stepId = "T9S9";
        bad.findings[0]!.references[0]!.pmid = "PMC1";
        bad.keyReferences[0]!.pmid = "PMC2";

        const result = (await validate.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap() as {
            valid: false;
            issues: { path: string; code: string }[];
        };

        expect(result.valid).toBe(false);
        expect(result.issues.every((i) => i.code === "semantic")).toBe(true);
        expect(result.issues.map((i) => i.path)).toEqual([
            "synthesis.runId",
            "synthesis.findings[0].stepId",
            "synthesis.themes[0].findings[0]",
            "synthesis.keyReferences[0].pmid",
            "synthesis.findings[0].references[0].pmid",
            "synthesis.keyReferences[0].pmid",
        ]);
        expect(holder.outcome).toBeNull();
    });

    it("reports semantic issues and leaves a recorded outcome untouched", async () => {
        const { validate, submit, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });
        await submit.execute({ synthesis: validSynthesisPayload() }, makeToolCtx());

        const bad = validSynthesisPayload() as { findings: { stepId: string }[] };
        bad.findings[0]!.stepId = "T9S9";

        const result = (await validate.execute({ synthesis: bad }, makeToolCtx()))._unsafeUnwrap() as {
            valid: false;
            issues: { code: string }[];
        };

        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.code === "semantic")).toBe(true);
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

    it("does not overwrite a recorded synthesis", async () => {
        const { submit, blocker, holder } = __buildInnerToolsForTest({
            knownStepIds: new Set(["T1S1"]),
            runId: RUN_ID,
        });
        await submit.execute({ synthesis: validSynthesisPayload() }, makeToolCtx());

        await blocker.execute({ reason: "changed my mind" }, makeToolCtx());

        expect(holder.outcome?.kind).toBe("submitted");
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

describe("blocker discipline copy", () => {
    it("scopes the blocker tool description to empty/incoherent inputs, not 'no findings worth surfacing'", () => {
        const { blocker } = __buildInnerToolsForTest({ knownStepIds: new Set(["T1S1"]), runId: RUN_ID });
        expect(blocker.description.toLowerCase()).not.toContain("worth surfacing");
        expect(blocker.description).toContain("empty findings[]");
        expect(blocker.description.toLowerCase()).toMatch(/incoheren/);
    });

    it("synthesizer prompt states an empty findings[] is a valid submission and not a blocker", () => {
        expect(synthesisAgentPrompt).toContain("is a valid submission");
        expect(synthesisAgentPrompt).toContain("NOT a blocker");
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
                workspaceRoot: join(tempDir, "analysis-001"),
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
