import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCapturingLogger, type CapturedLog, type CapturingLogger } from "../../__tests__/setup/logger.js";
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
    profiledAt: "2026-06-09T10:00:00.000Z",
    domain: "transcriptomics",
    subtype: "bulk-rna-seq",
    organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "metadata", confidence: "high" },
    tissue: "skin",
    condition: "atopic dermatitis",
    experimentalDesign: "6 AD_lesional vs 6 Control, unpaired, single batch",
    qualityAssessment: {
        concerns: ["Sample S7 has a library size 4x below the median"],
    },
};

const SEED_FILE_IDS = ["file-aaa", "file-bbb"];

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
        return createGeneratePlanTool({ conversation: { provider, model: "claude-test" }, pool });
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
        expect(provider.calls).toHaveLength(1);
        expect(provider.calls[0]!.toolChoice).toBe("required");

        // The planner ran on a derived child Session, offered every terminal tool. Only the
        // terminal set is asserted: those are what can record an outcome, so a missing one
        // is a planner that can run to completion with nothing to show for it. The rest of
        // the roster is deliberately not pinned here — an exact list turns every tool added
        // to the planner into an unrelated failure in a test about blocker outcomes.
        expect(provider.sessions[0]!.provenance.agentId).toBe("planner");
        expect(provider.sessions[0]!.provenance.callPath).toEqual(["conversation-agent", "planner"]);
        expect(Object.keys(provider.calls[0]!.tools)).toEqual(expect.arrayContaining(["submit_plan", "request_clarification", "report_blocker"]));
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
            if (callIndex === 0) return makeMessage([toolUseBlock("t1", "report_blocker", { reason: "probe only" })], "tool_use");
            // A second call would mean the terminal outcome failed to stop the loop.
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
        await createGeneratePlanTool({ conversation: { provider, model: "claude-test" }, pool, refStorePath: root }).execute(INPUT, toolContext());

        expect(Object.keys(provider.calls[0]!.tools)).not.toContain("list_available_refs");
        expect(Object.keys(provider.calls[0]!.tools)).toEqual(expect.arrayContaining(["submit_plan", "request_clarification", "report_blocker"]));
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
            const schema = createGeneratePlanTool({ conversation: { provider: scriptedProvider([]), model: "claude-test" }, pool }).jsonSchema as {
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
                seed: SEED_FILE_IDS,
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
            const provider = scriptedProvider([makeMessage([toolUseBlock("t1", "submit_plan", { plan: validCandidate() })], "tool_use")]);

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

        it("does not re-derive a changed input set as stale — a completed row is served as ready", async () => {
            const analysisId = "an-stale";
            // The seed names a file the stored profile never covered. That used to read as
            // drift here; re-profiling is now invoked by the embedder that owns the input
            // mutation, so a row still reading `completed` is a row nothing has superseded.
            await seedAnalysis(pool, analysisId, {
                dpStatus: "completed",
                result: RICH_PROFILE,
                seed: ["file-aaa", "file-bbb", "file-ccc"],
            });
            const provider = blockImmediately();

            await toolFor(provider).execute(INPUT, toolContext(analysisId));

            const context = dataContextBlock(plannerSeed(provider));
            expect(context).not.toContain("PROVISIONAL");
            expect(context).toContain("Homo sapiens (taxon 9606)");
        });

        it("marks a re-profile in flight PROVISIONAL, serving the previous profile", async () => {
            const analysisId = "an-reprofiling";
            // `tryRerunDataProfile` preserves `data_profile_result`, so a running row
            // can still carry the previous profile.
            await seedAnalysis(pool, analysisId, {
                dpStatus: "running",
                result: RICH_PROFILE,
                seed: SEED_FILE_IDS,
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
                seed: SEED_FILE_IDS,
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

    // ── Diagnostic records ───────────────────────────────────────────
    //
    // This tool returns `ok(...)` for every ending, so the return value distinguishes
    // nothing about how an invocation went. It is also a conversation-layer tool on
    // `passthroughStep`: no ledger row, no durable stream. The record is therefore the
    // only evidence that survives the turn, which is what these assertions protect.

    describe("outcome records", () => {
        function loggedToolFor(provider: ScriptedProvider): { tool: Tool; logger: CapturingLogger } {
            const logger = createCapturingLogger();
            return { tool: createGeneratePlanTool({ conversation: { provider, model: "claude-test" }, pool, logger }), logger };
        }

        /** The one per-invocation outcome record, failing loudly if there is not exactly one. */
        function outcomeRecord(logger: CapturingLogger): CapturedLog {
            const records = logger.records.filter((r) => r.msg.endsWith("plan generation finished"));
            expect(records).toHaveLength(1);
            return records[0]!;
        }

        it("records a submitted plan once, at info, with the elapsed time and analysis", async () => {
            const analysisId = "an-log-ok";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            const provider = scriptedProvider([
                makeMessage([toolUseBlock("t1", "submit_plan", { plan: validCandidate() })], "tool_use"),
                makeMessage([textBlock("Submitted.")], "end_turn"),
            ]);
            const { tool, logger } = loggedToolFor(provider);

            const result = (await tool.execute(INPUT, toolContext(analysisId)))._unsafeUnwrap() as PlanResult;
            expect(result.event).toBe("plan_complete");

            const record = outcomeRecord(logger);
            expect(record.level).toBe("info");
            expect(record.fields).toMatchObject({ outcome: "plan_submitted", analysisId });
            expect(typeof record.fields.elapsedMs).toBe("number");
        });

        it("records a clarification request at info — the tool working as designed", async () => {
            const provider = scriptedProvider([
                makeMessage([toolUseBlock("t1", "request_clarification", { question: "Which contrast?" })], "tool_use"),
                makeMessage([textBlock("Asked.")], "end_turn"),
            ]);
            const { tool, logger } = loggedToolFor(provider);

            await tool.execute(INPUT, toolContext());

            const record = outcomeRecord(logger);
            expect(record.level).toBe("info");
            expect(record.fields).toMatchObject({ outcome: "clarification" });
        });

        it("records a blocker at warn — a real answer that cost the user their plan", async () => {
            const { tool, logger } = loggedToolFor(blockImmediately());

            await tool.execute(INPUT, toolContext());

            const record = outcomeRecord(logger);
            expect(record.level).toBe("warn");
            expect(record.fields).toMatchObject({ outcome: "blocker" });
        });

        it("distinguishes the failure shapes rather than collapsing them to one error", async () => {
            // Ends on prose without ever recording an outcome — the salvage turn also
            // declines, so the invocation finishes with nothing submitted.
            const { tool, logger } = loggedToolFor(scriptedProvider(() => makeMessage([textBlock("thinking out loud")], "end_turn")));

            await tool.execute(INPUT, toolContext());

            const record = outcomeRecord(logger);
            expect(record.level).toBe("error");
            expect(record.fields).toMatchObject({ outcome: "no_outcome" });

            // A different failure carries a different kind, so the two are separable in a
            // log query — the whole reason the tool records a kind and not just "failed".
            const cancelled = createCapturingLogger();
            const aborted = new AbortController();
            aborted.abort();
            await createGeneratePlanTool({ conversation: { provider: scriptedProvider([]), model: "claude-test" }, pool, logger: cancelled }).execute(INPUT, {
                ...toolContext(),
                signal: aborted.signal,
            });

            const cancelledRecord = cancelled.records.filter((r) => r.msg.endsWith("plan generation finished"))[0]!;
            expect(cancelledRecord.fields.outcome).toBe("cancelled");
            expect(cancelledRecord.fields.outcome).not.toBe(record.fields.outcome);
        });

        it("records a submit that fails re-validation, which is the rejection that costs an iteration", async () => {
            // A dangling `depends_on` passes the strict arg schema and fails the semantic
            // checks, so `execute` runs and rejects — the path a schema-level bounce at the
            // loop's input boundary would never reach.
            const provider = scriptedProvider([
                makeMessage([toolUseBlock("t1", "submit_plan", { plan: validCandidate({ depends_on: ["T9S9"] }) })], "tool_use"),
                makeMessage([toolUseBlock("t2", "report_blocker", { reason: "cannot fix" })], "tool_use"),
                makeMessage([textBlock("Reported.")], "end_turn"),
            ]);
            const { tool, logger } = loggedToolFor(provider);

            await tool.execute(INPUT, toolContext());

            // `warn`, not `debug`: a rejection costs an iteration and is otherwise unreported,
            // so it must survive the default level a host actually runs at.
            const rejection = logger.records.filter((r) => r.level === "warn" && r.msg.includes("submit_plan rejected"));
            expect(rejection).toHaveLength(1);
            expect(rejection[0]!.fields).toMatchObject({ attempt: 1, codes: { schema: 0, semantic: 1 } });
            expect(rejection[0]!.fields.issueCount).toBeGreaterThan(0);
            expect(rejection[0]!.fields.paths).toEqual(["plan"]);
            expect(rejection[0]!.fields.messages).toBeArrayOfSize(1);
        });

        it("records no rejection when the first submit is accepted", async () => {
            const accepted = loggedToolFor(
                scriptedProvider([
                    makeMessage([toolUseBlock("t1", "submit_plan", { plan: validCandidate() })], "tool_use"),
                    makeMessage([textBlock("Submitted.")], "end_turn"),
                ]),
            );

            await accepted.tool.execute(INPUT, toolContext("an-log-accept"));

            expect(accepted.logger.records.filter((r) => r.msg.includes("rejected"))).toHaveLength(0);
        });

        it("opens with a seed census, so a run that never returns can be weighed against what it was handed", async () => {
            const analysisId = "an-log-seed";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            const { tool, logger } = loggedToolFor(blockImmediately());

            await tool.execute({ ...INPUT, userConstraints: "Use limma-voom." }, toolContext(analysisId));

            const started = logger.records.filter((r) => r.msg.endsWith("plan generation started"));
            expect(started).toHaveLength(1);
            expect(started[0]!.level).toBe("info");
            expect(started[0]!.fields).toMatchObject({ grounding: "ready", analysisId });

            // Sizes, never content: the seed carries the research question and the dataset's
            // facts, which belong in the model's context and not in a log file.
            const seedChars = started[0]!.fields.seedChars as Record<string, number>;
            expect(seedChars.total).toBeGreaterThan(0);
            expect(seedChars.dataContext).toBeGreaterThan(0);
            expect(seedChars.userConstraints).toBe("Use limma-voom.".length);
            expect(seedChars.priorRuns).toBe(0);
            const census = JSON.stringify(started[0]!.fields);
            expect(census).not.toContain(INPUT.researchQuestion);
            expect(census).not.toContain("limma-voom");
        });

        it("carries the loop account on a run that ended with no terminal outcome", async () => {
            // The reported failure: three identical `no_outcome` returns taught nobody
            // anything, because the word covers a budget spent on rejected submits, a planner
            // answering in prose, and a reply cut off mid-tool-call alike.
            const { tool, logger } = loggedToolFor(scriptedProvider(() => makeMessage([textBlock("Let me think about this out loud.")], "end_turn")));

            await tool.execute(INPUT, toolContext());

            const record = outcomeRecord(logger);
            expect(record.fields.outcome).toBe("no_outcome");
            expect(record.fields.loop).toMatchObject({ finishReason: "stop", salvaged: true, firstFinishReason: "stop", toolCalls: [] });
            // The planner's last words — the single artifact that explains a run which stopped
            // talking instead of calling a terminal tool, and which nothing else preserves.
            expect(record.fields.modelAuthored).toMatchObject({ plannerFinalProse: expect.stringContaining("think about this out loud") });
        });

        it("nests model prose under one key and omits it where something else explains the outcome", async () => {
            const analysisId = "an-log-prose";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            // A real planner narrates alongside its tool call, and that narration quotes the
            // dataset it was handed. On a submitted plan nothing needs it: the terminal tool
            // already recorded what was decided, so the prose would be model output describing
            // the user's data sitting in a record that has no use for it.
            const { tool, logger } = loggedToolFor(
                scriptedProvider([
                    makeMessage(
                        [
                            textBlock("These are atopic dermatitis skin biopsies; S7 is a QC outlier."),
                            toolUseBlock("t1", "submit_plan", { plan: validCandidate() }),
                        ],
                        "tool_use",
                    ),
                ]),
            );

            const result = (await tool.execute(INPUT, toolContext(analysisId)))._unsafeUnwrap() as PlanResult;
            expect(result.event).toBe("plan_complete");

            const record = outcomeRecord(logger);
            expect(record.fields).not.toHaveProperty("modelAuthored");
            expect(JSON.stringify(record.fields)).not.toContain("atopic dermatitis");
            // The structural account still lands in full — the omission is scoped to prose.
            expect(record.fields.loop).toMatchObject({ finishReason: "stop", toolCalls: ["submit_plan"] });
        });

        it("shows a budget spent on rejected submits as exactly that, not as a silent no-outcome", async () => {
            const analysisId = "an-log-thrash";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            // Every turn submits a plan whose `depends_on` names a step that does not exist:
            // schema-valid, semantically impossible, rejected forever. This is the shape that
            // burns a whole iteration budget while `holder.outcome` stays null.
            const { tool, logger } = loggedToolFor(
                scriptedProvider((i) => makeMessage([toolUseBlock(`t${i}`, "submit_plan", { plan: validCandidate({ depends_on: ["T9S9"] }) })], "tool_use")),
            );

            const result = (await tool.execute(INPUT, toolContext(analysisId)))._unsafeUnwrap() as PlanResult;
            expect(result.event).toBe("error");

            const record = outcomeRecord(logger);
            expect(record.fields.outcome).toBe("no_outcome");
            expect(record.fields.submitAttempts).toBeGreaterThan(1);
            expect(record.fields.rejectedAttempts).toBeGreaterThan(1);
            expect(record.fields.loop).toMatchObject({ finishReason: "max_iterations", cappedOut: true, salvaged: true });
            expect(record.fields.loop).toHaveProperty("toolCalls");
            expect((record.fields.loop as { toolCalls: string[] }).toolCalls).toContain("submit_plan");

            // Identical `paths` across attempts is the planner stuck on one fault — the
            // difference between "give it more budget" and "the plan can never be made valid".
            const rejections = record.fields.rejections as { attempt: number; paths: string[] }[];
            expect(rejections.length).toBeGreaterThan(1);
            expect(rejections[0]!.attempt).toBe(1);
            expect(rejections[0]!.paths).toEqual(rejections[1]!.paths);

            // The kept rejections are capped, the COUNT is not. A record pairing 16 attempts
            // with 6 rejections reads as ten accepted plans — the opposite of what happened —
            // so the truncation is stated and the count stays whole.
            expect(record.fields.rejectedAttempts).toBe(record.fields.submitAttempts);
            expect(rejections.length).toBeLessThan(record.fields.rejectedAttempts as number);
            expect(record.fields.rejectionsTruncated).toBe(true);
        });

        it("names the attempt a plan was accepted on — a success that nearly was not one", async () => {
            const analysisId = "an-log-late";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            const { tool, logger } = loggedToolFor(
                scriptedProvider([
                    makeMessage([toolUseBlock("t1", "submit_plan", { plan: validCandidate({ depends_on: ["T9S9"] }) })], "tool_use"),
                    makeMessage([toolUseBlock("t2", "submit_plan", { plan: validCandidate() })], "tool_use"),
                    makeMessage([textBlock("Submitted.")], "end_turn"),
                ]),
            );

            await tool.execute(INPUT, toolContext(analysisId));

            const accepted = logger.records.filter((r) => r.msg.endsWith("submit_plan accepted a plan"));
            expect(accepted).toHaveLength(1);
            expect(accepted[0]!.fields).toMatchObject({ attempt: 2, stepCount: 1 });

            const record = outcomeRecord(logger);
            expect(record.fields).toMatchObject({ outcome: "plan_submitted", submitAttempts: 2, rejectedAttempts: 1 });
        });

        it("reports a blocker with the attempt count, separating giving up from never trying", async () => {
            const { tool, logger } = loggedToolFor(blockImmediately());

            await tool.execute(INPUT, toolContext());

            const blocker = logger.records.filter((r) => r.msg.endsWith("planner reported a blocker"));
            expect(blocker).toHaveLength(1);
            expect(blocker[0]!.level).toBe("warn");
            expect(blocker[0]!.fields.submitAttempts).toBe(0);
            // The reason is the planner's own prose, so it rides under the key an embedder
            // can act on wholesale. A loose `reason` would also collide with the loop's
            // structural `reason` (its finish reason) in any sink that filters by name.
            expect(blocker[0]!.fields).not.toHaveProperty("reason");
            expect(blocker[0]!.fields.modelAuthored).toMatchObject({ blockerReason: "measurement complete" });
        });
    });
});
