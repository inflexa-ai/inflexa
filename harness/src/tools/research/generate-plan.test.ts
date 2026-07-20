import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ToolResultPart } from "ai";
import type { Pool } from "pg";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { PLANNABLE_AGENT_IDS } from "../../agents/sandbox-catalog.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock, type ScriptedProvider } from "../../loop/__fixtures__/scripted-provider.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import type { DataProfileResult } from "../../state/index.js";
import type { Tool, ToolContext } from "../define-tool.js";
import { createGeneratePlanTool } from "./generate-plan.js";

/** A ToolContext whose session scopes the tool to `analysisId` — where it reads the profile from. */
function toolContext(analysisId = "analysis-001"): ToolContext {
    return {
        session: makeSession({
            scope: { kind: "analysis", analysisId },
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        }),
        signal: new AbortController().signal,
        emit: () => {},
        runStep: (_name, fn) => fn(),
    };
}

interface PlanResult {
    event: string;
    error?: string;
    question?: string;
    planId?: string;
}

/**
 * Everything the caller supplies. There is no dataset field here — the dataset's
 * facts are the tool's to read, not the caller's to re-type.
 */
const INPUT = {
    researchQuestion: "Which genes are differentially expressed?",
};

interface ValidateOutput {
    valid: boolean;
    issues: { path: string; code: "schema" | "semantic"; message: string }[];
}

/** The tool-result part the loop fed back to the model for `toolName`. */
function toolResultFor(provider: ScriptedProvider, toolName: string): ToolResultPart | undefined {
    for (const call of provider.calls) {
        for (const message of call.messages) {
            if (message.role !== "tool") continue;
            const part = message.content.find((p) => p.type === "tool-result" && p.toolName === toolName);
            if (part) return part as ToolResultPart;
        }
    }
    return undefined;
}

/** Read a successful tool result's JSON payload, failing loudly on an error result. */
function validateOutput(provider: ScriptedProvider): ValidateOutput {
    const part = toolResultFor(provider, "validate_plan");
    expect(part).toBeDefined();
    // "error-text" is what the loop's Zod boundary emits when it rejects input
    // before `execute` — validate_plan must never bounce a candidate that way.
    expect(part!.output.type).toBe("json");
    return (part!.output as { type: "json"; value: unknown }).value as ValidateOutput;
}

/** The seed the planner was actually handed — the bytes the model saw, not what the caller passed. */
function plannerSeed(provider: ScriptedProvider): string {
    const first = provider.calls[0]?.messages[0];
    expect(first?.role).toBe("user");
    const content = first!.content;
    return typeof content === "string" ? content : JSON.stringify(content);
}

/** The `## Data Context` block on its own — everything up to the next `## ` heading. */
function dataContextBlock(seed: string): string {
    const start = seed.indexOf("## Data Context");
    if (start === -1) return "";
    const rest = seed.slice(start + "## Data Context".length);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
}

/** Script: validate a candidate, then bail out terminally so nothing is persisted. */
function validateThenBlock(candidate: unknown): ScriptedProvider {
    return scriptedProvider([
        makeMessage([toolUseBlock("t1", "validate_plan", { plan: candidate })], "tool_use"),
        makeMessage([toolUseBlock("t2", "report_blocker", { reason: "measurement complete" })], "tool_use"),
        makeMessage([textBlock("Reported.")], "end_turn"),
    ]);
}

/** Script: bail out terminally on the first turn — the seed is all this measures. */
function blockImmediately(): ScriptedProvider {
    return scriptedProvider([
        makeMessage([toolUseBlock("t1", "report_blocker", { reason: "measurement complete" })], "tool_use"),
        makeMessage([textBlock("Reported.")], "end_turn"),
    ]);
}

/** A schema-valid planner plan — one step, on a real plannable agent. */
function validCandidate(stepOverrides: Record<string, unknown> = {}) {
    return {
        title: "Bulk RNA-seq differential expression",
        analytical_narrative: "One DE step answers the question directly.",
        created_at: "2025-01-01T00:00:00Z",
        steps: [
            {
                id: "T1S1",
                name: "Differential expression",
                track: "T1",
                step_type: "analysis",
                question: "Which genes are differentially expressed between the two conditions?",
                acceptance_criteria: ["A ranked DE table is produced."],
                depends_on: [],
                agent: PLANNABLE_AGENT_IDS[0],
                resources: { cpu: 2, memoryGb: 8 },
                ...stepOverrides,
            },
        ],
    };
}

// ── Profile fixtures ─────────────────────────────────────────────────

/** A profile carrying every fact a caller used to have to re-type by hand. */
const RICH_PROFILE: DataProfileResult = {
    summary: "Bulk RNA-seq count matrix with sample metadata.",
    files: [
        {
            path: "data/inputs/f1/counts.csv",
            description: "Raw gene-level count matrix",
            dataType: "count-matrix",
            format: "CSV",
            rows: 20000,
            cols: 12,
        },
        { path: "data/inputs/f2/metadata.csv", description: "Sample metadata", dataType: "clinical-metadata", format: "CSV", rows: 12, cols: 4 },
    ],
    inputFileIds: ["file-aaa", "file-bbb"],
    profiledAt: "2026-06-09T10:00:00.000Z",
    domain: "transcriptomics",
    subtype: "bulk-rna-seq",
    organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "metadata", confidence: "high" },
    tissue: "skin",
    condition: "atopic dermatitis",
    experimentalDesign: "6 AD_lesional vs 6 Control, unpaired, single batch",
    qualityAssessment: {
        concerns: ["Sample S7 has a library size 4x below the median"],
        strengths: ["Replicate correlation above 0.95"],
    },
};

interface SeedOptions {
    /** `data_profile_status`. NULL is the honest "no profile" state. */
    readonly dpStatus?: string | null;
    readonly result?: DataProfileResult | null;
    /** `seed_input_file_ids` — the CURRENT input set, which a stale profile no longer covers. */
    readonly seed?: string[] | null;
}

async function seedAnalysis(pool: Pool, analysisId: string, opts: SeedOptions = {}): Promise<void> {
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state
           (analysis_id, status, context, data_profile_status, data_profile_result, seed_input_file_ids, created_at, updated_at)
           VALUES ($1, 'active', NULL, $2, $3::jsonb, $4::jsonb, $5, $6)`,
        values: [analysisId, opts.dpStatus ?? null, opts.result ? JSON.stringify(opts.result) : null, opts.seed ? JSON.stringify(opts.seed) : null, now, now],
    });
}

describe("generatePlan loop-driving tool", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("generate_plan_tool");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    /** Rebuild the tool per test — the provider is the only thing that varies. */
    function toolFor(provider: ScriptedProvider): Tool {
        return createGeneratePlanTool({ provider, pool, model: "claude-test" });
    }

    // ── Outcome shaping ──────────────────────────────────────────────

    it("surfaces report_blocker as an error outcome", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("t1", "report_blocker", {
                        reason: "Data is incompatible with every available agent.",
                    }),
                ],
                "tool_use",
            ),
            makeMessage([textBlock("Reported.")], "end_turn"),
        ]);

        const result = (await toolFor(provider).execute(INPUT, toolContext()))._unsafeUnwrap() as PlanResult;

        expect(result.event).toBe("error");
        expect(result.error).toBe("Data is incompatible with every available agent.");

        // The planner ran on a derived child Session with its 4 terminal tools.
        expect(provider.sessions[0]!.provenance.agentId).toBe("planner");
        expect(provider.sessions[0]!.provenance.callPath).toEqual(["conversation-agent", "planner"]);
        expect(Object.keys(provider.calls[0]!.tools)).toEqual([
            "validate_plan",
            "list_available_refs",
            "submit_plan",
            "request_clarification",
            "report_blocker",
        ]);
    });

    // The planner has no sandbox, so reference discovery is only attachable because it
    // reads the store host-side. A plan should be able to name what this install holds
    // rather than assuming, which is the whole reason the tool is offered here.
    //
    // `provider.calls[i].messages` is ONE array the loop mutates in place, so every
    // recorded call aliases the final transcript — assert against the whole exchange,
    // never a positional index into a snapshot that does not exist.
    function refsProbe(): ScriptedProvider {
        return scriptedProvider((callIndex) => {
            if (callIndex === 0) return makeMessage([toolUseBlock("t1", "list_available_refs", { query: "regulon" })], "tool_use");
            if (callIndex === 1) return makeMessage([toolUseBlock("t2", "report_blocker", { reason: "probe only" })], "tool_use");
            // Without a terminal end_turn the loop keeps requesting tools until it hits
            // its iteration cap — the blocker records an outcome, it does not stop the loop.
            return makeMessage([textBlock("Reported.")], "end_turn");
        });
    }

    /** The whole planner transcript, as one searchable string. */
    function transcript(provider: ScriptedProvider): string {
        return JSON.stringify(provider.calls[0]?.messages ?? []);
    }

    it("gives the planner reference discovery over the host store, with no sandbox", async () => {
        const root = await mkdtemp(join(tmpdir(), "planner-refs-"));
        await mkdir(join(root, "managed", "collectri-human", "2.0"), { recursive: true });
        await writeFile(join(root, "managed", "collectri-human", "2.0", "CollecTRI_regulons.csv"), "source,target");

        const provider = refsProbe();
        await createGeneratePlanTool({ provider, pool, model: "claude-test", refStorePath: root }).execute(INPUT, toolContext());

        expect(Object.keys(provider.calls[0]!.tools)).toContain("list_available_refs");
        expect(transcript(provider)).toContain("/mnt/refs/managed/collectri-human/2.0/CollecTRI_regulons.csv");
        // The planner sees the same meaning-bearing labels a sandbox agent does.
        expect(transcript(provider)).toContain("regulon");
    });

    it("reports no reference store to the planner when none is configured", async () => {
        const provider = refsProbe();
        await toolFor(provider).execute(INPUT, toolContext());

        expect(transcript(provider)).toContain("No reference store is provisioned");
    });

    it("surfaces request_clarification as a clarification outcome", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("t1", "request_clarification", {
                        question: "Which two conditions should be contrasted?",
                    }),
                ],
                "tool_use",
            ),
            makeMessage([textBlock("Asked.")], "end_turn"),
        ]);

        const result = (await toolFor(provider).execute(INPUT, toolContext()))._unsafeUnwrap() as PlanResult;

        expect(result.event).toBe("clarification_needed");
        expect(result.question).toBe("Which two conditions should be contrasted?");
    });

    it("validate_plan reports a malformed candidate as data instead of rejecting it at the input boundary", async () => {
        // Structurally broken: no title, steps is not an array. A strict
        // inputSchema would bounce this at the loop's Zod boundary and never
        // reach `execute` — leaving the planner with nothing to fix.
        const provider = validateThenBlock({ steps: "one DE step", analytical_narrative: 42 });

        await toolFor(provider).execute(INPUT, toolContext());

        const output = validateOutput(provider);
        expect(output.valid).toBe(false);
        expect(output.issues.length).toBeGreaterThan(0);
        expect(output.issues.some((i) => i.code === "schema")).toBe(true);
        expect(output.issues.every((i) => i.path.startsWith("plan"))).toBe(true);
    });

    it("validate_plan reports semantic issues a schema cannot express", async () => {
        // Schema-valid, semantically broken: depends_on points at a step that
        // does not exist in the plan.
        const provider = validateThenBlock(validCandidate({ depends_on: ["T9S9"] }));

        await toolFor(provider).execute(INPUT, toolContext());

        const output = validateOutput(provider);
        expect(output.valid).toBe(false);
        expect(output.issues.some((i) => i.code === "semantic")).toBe(true);
        expect(JSON.stringify(output.issues)).toContain("T9S9");
    });

    it("validate_plan accepts a clean candidate", async () => {
        const provider = validateThenBlock(validCandidate());

        await toolFor(provider).execute(INPUT, toolContext());

        expect(validateOutput(provider)).toEqual({ valid: true, issues: [] });
    });

    it("errors when the planner ends without a terminal tool call", async () => {
        // Prose every turn — including the terminal-salvage continuation — so no
        // terminal outcome is ever recorded.
        const provider = scriptedProvider(() => makeMessage([textBlock("Here is a plan, described in prose.")], "end_turn"));

        const result = (await toolFor(provider).execute(INPUT, toolContext()))._unsafeUnwrap() as PlanResult;

        expect(result.event).toBe("error");
        expect(result.error).toContain("without a terminal outcome");
    });

    // ── Data context: the profile reaches the planner, the caller never types it ──

    describe("data context", () => {
        it("takes no dataset field from the caller at all", () => {
            const schema = createGeneratePlanTool({ provider: scriptedProvider([]), pool, model: "claude-test" }).jsonSchema as {
                properties: Record<string, unknown>;
                required?: string[];
            };

            expect(Object.keys(schema.properties)).not.toContain("dataContext");
            expect(Object.keys(schema.properties).sort()).toEqual(["analystNotes", "parentPlanId", "priorRuns", "researchQuestion", "userConstraints"]);
            expect(schema.required).toEqual(["researchQuestion"]);
        });

        it("seeds the planner with the persisted profile's facts, none of which the caller supplied", async () => {
            const analysisId = "an-profiled";
            await seedAnalysis(pool, analysisId, {
                dpStatus: "completed",
                result: RICH_PROFILE,
                seed: RICH_PROFILE.inputFileIds,
            });
            const provider = blockImmediately();

            await toolFor(provider).execute(INPUT, toolContext(analysisId));

            const seed = plannerSeed(provider);
            const context = dataContextBlock(seed);

            // The caller passed a research question and nothing else — every dataset
            // fact below reached the planner from the ledger.
            expect(seed).toContain("## Data Context");
            expect(context).toContain("transcriptomics / bulk-rna-seq");
            expect(context).toContain("Homo sapiens (taxon 9606)");
            expect(context).toContain("6 AD_lesional vs 6 Control, unpaired, single batch");
            expect(context).toContain("Sample S7 has a library size 4x below the median");
            expect(context).toContain("data/inputs/f1/counts.csv");
            expect(context).toContain("20000 x 12");
            expect(context).not.toContain("PROVISIONAL");
            expect(seed).toContain("## Research Question");
        });

        it("plans without a profile: no data-context section, and the plan still lands", async () => {
            const analysisId = "an-unprofiled";
            // A real analysis with a NULL profile status — the honest "never profiled"
            // state `loadDataProfileStatus` collapses to null.
            await seedAnalysis(pool, analysisId, { dpStatus: null });
            const provider = scriptedProvider([
                makeMessage([toolUseBlock("t1", "validate_plan", { plan: validCandidate() })], "tool_use"),
                makeMessage([toolUseBlock("t2", "submit_plan", { plan: validCandidate() })], "tool_use"),
                makeMessage([textBlock("Submitted.")], "end_turn"),
            ]);

            const result = (await toolFor(provider).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap() as PlanResult;

            // Planning proceeds to a persisted plan — a missing profile costs grounding,
            // never the plan.
            expect(result.event).toBe("plan_complete");
            expect(result.planId).toMatch(/^pln-[a-f0-9]{8}$/);

            const seed = plannerSeed(provider);
            expect(seed).not.toContain("## Data Context");
            expect(seed).toContain("## Research Question");

            const persisted = await pool.query({
                text: "SELECT plan_id FROM cortex_plans WHERE analysis_id = $1",
                values: [analysisId],
            });
            expect(persisted.rows).toHaveLength(1);
        });

        it("marks a stale profile PROVISIONAL in the seed, and still serves its facts", async () => {
            const analysisId = "an-stale";
            // The analysis's CURRENT inputs are not the ones the profile covered.
            await seedAnalysis(pool, analysisId, {
                dpStatus: "completed",
                result: RICH_PROFILE,
                seed: ["file-aaa", "file-bbb", "file-ccc"],
            });
            const provider = blockImmediately();

            await toolFor(provider).execute(INPUT, toolContext(analysisId));

            const context = dataContextBlock(plannerSeed(provider));
            expect(context).toContain("PROVISIONAL");
            expect(context).toContain("input file set changed");
            // Stale beats absent: the facts are still handed over.
            expect(context).toContain("Homo sapiens (taxon 9606)");
        });

        it("marks a re-profile in flight PROVISIONAL, serving the previous profile", async () => {
            const analysisId = "an-reprofiling";
            // `tryRerunDataProfile` preserves `data_profile_result`, so a running row
            // can still carry the previous profile.
            await seedAnalysis(pool, analysisId, {
                dpStatus: "running",
                result: RICH_PROFILE,
                seed: RICH_PROFILE.inputFileIds,
            });
            const provider = blockImmediately();

            await toolFor(provider).execute(INPUT, toolContext(analysisId));

            const context = dataContextBlock(plannerSeed(provider));
            expect(context).toContain("PROVISIONAL");
            expect(context).toContain("re-profile is in progress");
            expect(context).toContain("Homo sapiens (taxon 9606)");
        });

        it("says so in the seed when profiling is still running and has produced nothing yet", async () => {
            const analysisId = "an-pending";
            await seedAnalysis(pool, analysisId, { dpStatus: "running", result: null, seed: ["file-aaa"] });
            const provider = blockImmediately();

            await toolFor(provider).execute(INPUT, toolContext(analysisId));

            const context = dataContextBlock(plannerSeed(provider));
            expect(context).toContain("still being profiled");
            expect(context).toContain("do not invent dataset specifics");
            expect(context).not.toContain("Homo sapiens");
        });

        it("says so in the seed when profiling failed and no earlier profile exists", async () => {
            const analysisId = "an-failed";
            await seedAnalysis(pool, analysisId, { dpStatus: "failed", result: null, seed: ["file-aaa"] });
            await pool.query({
                text: "UPDATE cortex_analysis_state SET data_profile_error = $1 WHERE analysis_id = $2",
                values: ["profiler ran out of memory", analysisId],
            });
            const provider = blockImmediately();

            await toolFor(provider).execute(INPUT, toolContext(analysisId));

            const context = dataContextBlock(plannerSeed(provider));
            expect(context).toContain("Data profiling failed");
            expect(context).toContain("profiler ran out of memory");
            expect(context).toContain("do not invent dataset specifics");
        });

        it("keeps user-supplied facts in their own section, apart from the server-derived orientation", async () => {
            const analysisId = "an-notes";
            await seedAnalysis(pool, analysisId, {
                dpStatus: "completed",
                result: RICH_PROFILE,
                seed: RICH_PROFILE.inputFileIds,
            });
            const provider = blockImmediately();
            const note = "Samples 3 and 7 were re-sequenced; treat batch B as the reference.";

            await toolFor(provider).execute({ ...INPUT, analystNotes: note }, toolContext(analysisId));

            const seed = plannerSeed(provider);
            expect(seed).toContain("## Analyst Notes");
            expect(seed).toContain(note);

            // The two are distinct sections: the note never leaks into the block the
            // server derived from the profile, and the profile's facts never appear
            // under the user's heading.
            expect(dataContextBlock(seed)).not.toContain(note);
            expect(seed.indexOf("## Data Context")).toBeLessThan(seed.indexOf("## Analyst Notes"));

            const notes = seed.slice(seed.indexOf("## Analyst Notes"));
            expect(notes).not.toContain("Homo sapiens");
        });
    });
});
