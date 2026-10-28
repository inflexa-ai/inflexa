import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { inProcessSubAgent } from "../../../loop/sub-agent.js";
import { PLAN_ID_RE } from "../../../contracts/schemas/chat-parts.js";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { okAsync } from "neverthrow";
import { z } from "zod";
import { parseUnknownRecord } from "../../../lib/unknown-containers.js";
import type { Pool } from "pg";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCapturingLogger, type CapturedLog, type CapturingLogger } from "../../../__tests__/setup/logger.js";
import { withSchema } from "../../../__tests__/setup/postgres.js";
import { PLANNABLE_AGENT_IDS } from "../../../agents/sandbox-catalog.js";
import { SANDBOX_AGENT_META } from "../../../agents/sandbox/index.js";
import type { ToolOutputStore } from "../../../loop/tool-output.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import type { ChatProvider } from "../../../providers/types.js";
import { PlanningAgentOutputSchema, type PlanningAgentOutput } from "../../../schemas/plan-schemas.js";
import { loadPlan, type DataProfileResult } from "../../../state/index.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptedModel, type ScriptStep } from "../../../testing.js";
import type { Tool, ToolContext } from "../../define-tool.js";
import { fakeKnowledgeClient, SNAPSHOT } from "../../knowledge/__fixtures__/fake-client.js";
import { createGeneratePlanTool, type GeneratePlanDeps } from "../generate-plan.js";
import { presentAt, presentFirst, presentGet } from "../../../lib/present.js";
import { awaitOk } from "../../../lib/test/result-assert.js";

/** The key slice the search tools of the planner take. An empty key keeps every tool constructible offline. */
const TEST_BIO_KEYS = { drugbank: "", disgenet: "", epaCcte: "" };

const TERMINAL_TOOLS = ["submit_plan", "request_clarification", "report_blocker"];

/** A ToolContext whose session scopes the tool to `analysisId` — where it reads the profile from. */
function toolContext(analysisId = "analysis-001", options: { readonly emitted?: unknown[]; readonly invocationId?: string } = {}): ToolContext {
    return {
        invocationId: options.invocationId ?? "tool-call-test",
        session: makeSession({
            scope: { kind: "analysis", analysisId },
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        }),
        signal: new AbortController().signal,
        emit: (event) => {
            options.emitted?.push(event);
        },
    };
}

/**
 * Everything the caller supplies. There is no dataset field here — the dataset's
 * facts are the tool's to read, not the caller's to re-type.
 */
const INPUT = {
    researchQuestion: "Which genes are differentially expressed?",
};

/** A situation that the knowledge tools accept. */
const SITUATION = {
    question: "differential_expression",
    modality: "bulk_rna_seq",
    data_state: "counts",
    organism: "human",
    n_groups: 2,
    n_per_group_min: 6,
    n_per_group_max: 6,
    paired: false,
    batch: "none",
};

/**
 * The planner outcome, parsed with the schema the tool itself declares. The
 * tool's `execute` returns its output as `unknown`, so the parse is the check
 * the read rests on; it fails the test when the outcome shape drifts.
 */
function planResultOf(value: unknown): PlanningAgentOutput {
    return PlanningAgentOutputSchema.parse(value);
}

/** The plan id the accepted run reported; absence fails the test by name. */
function planIdOf(result: PlanningAgentOutput): string {
    if (result.planId === undefined) throw new Error("the plan id is absent");
    return result.planId;
}

/**
 * The stored plan, parsed out of the state layer's `unknown` payload. The
 * grounding fields are the ones the restore tests read; the parse fails the
 * test when the stored shape drifts.
 */
function storedPlan(stored: unknown): {
    steps: Array<{ id?: string; grounding?: { snapshot?: string; status?: string; template?: string; claims?: string[] } }>;
} {
    return z
        .object({
            steps: z.array(
                z.object({
                    id: z.string().optional(),
                    grounding: z
                        .object({
                            snapshot: z.string().optional(),
                            status: z.string().optional(),
                            template: z.string().optional(),
                            claims: z.array(z.string()).optional(),
                        })
                        .optional(),
                }),
            ),
        })
        .parse(stored);
}

/** The seed the planner was actually handed — the bytes the model saw, not what the caller passed. */
function plannerSeed(model: ScriptedModel): string {
    const user = presentFirst(model.calls, "the first model request").prompt.find((message) => message.role === "user");
    if (user?.role !== "user") throw new Error("the first request holds no user message");
    return user.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The `## Data Context` block on its own — everything up to the next `## ` heading. */
function dataContextBlock(seed: string): string {
    const start = seed.indexOf("## Data Context");
    if (start === -1) return "";
    const rest = seed.slice(start + "## Data Context".length);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
}

/** The first request of the planner, as one searchable string. */
function transcript(model: ScriptedModel): string {
    return JSON.stringify(model.calls[0]?.prompt ?? []);
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

const ErrorTextSchema = z.object({ type: z.literal("error-text"), value: z.string() });

/** The text of the error result of one tool call; a call that ran with no error fails the parse. */
function errorTextIn(call: LanguageModelV4CallOptions, toolCallId: string): string {
    return ErrorTextSchema.parse(toolResultIn(call, toolCallId)).value;
}

const IterationEventSchema = z.object({
    type: z.literal("iteration"),
    source: z.object({ agentId: z.string(), callPath: z.array(z.string()) }),
});

const reported = reply([text("Reported.")]);

const submitted = reply([text("Submitted.")]);

/** Script: bail out terminally on the first turn — the seed is all this measures. */
function blockImmediately(reason = "measurement complete"): ScriptedModel {
    return scriptedModel([callTools(toolCall("t1", "report_blocker", { reason })), reported]);
}

/** One phrase the first plannable agent really advertises — the planner schema takes nothing else. */
const FIRST_AGENT_CAPABILITY = presentGet(SANDBOX_AGENT_META, PLANNABLE_AGENT_IDS[0]).capabilities[0];
if (FIRST_AGENT_CAPABILITY === undefined) throw new Error("FIRST_AGENT_CAPABILITY is absent");

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
                capability: FIRST_AGENT_CAPABILITY,
                packages: ["pydeseq2"],
                ...stepOverrides,
            },
        ],
    };
}

const submitPlan = (id: string, plan: unknown) => toolCall(id, "submit_plan", { plan });

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

type SeedOptions = {
    /** `data_profile_status`. NULL is the honest "no profile" state. */
    readonly dpStatus?: string | null;
    readonly result?: DataProfileResult | null;
    /** `seed_input_file_ids` — the CURRENT input set, which a stale profile no longer covers. */
    readonly seed?: string[] | null;
};

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

    /** Rebuild the tool per test — the model and the optional deps are what vary. */
    function toolFor(provider: ChatProvider, extra: Partial<GeneratePlanDeps> = {}): Tool {
        return createGeneratePlanTool({ conversation: { provider, model: "claude-test" }, pool, bioKeys: TEST_BIO_KEYS, ...extra }, inProcessSubAgent);
    }

    // ── Outcome shaping ──────────────────────────────────────────────

    it("surfaces report_blocker as an error outcome", async () => {
        const model = blockImmediately("Data is incompatible with every available agent.");
        const emitted: unknown[] = [];

        const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext("analysis-001", { emitted })))._unsafeUnwrap());

        expect(result.event).toBe("error");
        expect(result.error).toBe("Data is incompatible with every available agent.");
        // The blocker does not end the run: the model reads its result, and its reply ends the run.
        expect(model.calls).toHaveLength(2);
        // No forced tool choice: some Claude models reject one with a 400.
        expect(presentAt(model.calls, 0).toolChoice).toEqual({ type: "auto" });

        // The planner ran on a derived child Session, offered every terminal tool. Only the
        // terminal set is asserted: those are what can record an outcome, so a missing one
        // is a planner that can run to completion with nothing to show for it. The rest of
        // the roster is deliberately not pinned here — an exact list turns every tool added
        // to the planner into an unrelated failure in a test about blocker outcomes.
        const iteration = emitted.flatMap((event) => {
            const parsed = IterationEventSchema.safeParse(event);
            return parsed.success ? [parsed.data] : [];
        });
        expect(presentAt(iteration, 0).source).toMatchObject({ agentId: "planner", callPath: ["conversation-agent", "planner"] });
        expect(toolNamesOf(presentAt(model.calls, 0)).slice(-3)).toEqual(TERMINAL_TOOLS);
    });

    // The planner has no sandbox, so reference discovery is only attachable because it
    // reads the store host-side. A plan should be able to name what this install holds
    // rather than assuming, which is the whole reason the tool is offered here.
    it("gives the planner reference discovery over the host store, with no sandbox", async () => {
        const root = await mkdtemp(join(tmpdir(), "planner-refs-"));
        await mkdir(join(root, "managed", "collectri-human", "2.0"), { recursive: true });
        await writeFile(join(root, "managed", "collectri-human", "2.0", "CollecTRI_regulons.csv"), "source,target");

        const model = blockImmediately("probe only");
        await awaitOk(toolFor(model.provider, { refStorePath: root }).execute(INPUT, toolContext()));

        const offered = toolNamesOf(presentAt(model.calls, 0));
        for (const id of [...TERMINAL_TOOLS, "list_available_refs"]) expect(offered).toContain(id);
        // The census still rides in the seed. The tool is for the narrow second
        // look, thus the planner never has to call one to learn what is staged.
        expect(transcript(model)).toContain("/mnt/refs/managed/collectri-human/2.0/CollecTRI_regulons.csv");
        // The planner sees the same meaning-bearing labels a sandbox agent does.
        expect(transcript(model)).toContain("regulon");
    });

    it("declares read_tool_output after the search tools and before the terminal tools when it has a tool output store", async () => {
        const model = blockImmediately("probe only");
        const toolOutputStore: ToolOutputStore = { put: () => okAsync(undefined), get: () => okAsync(null) };

        await awaitOk(toolFor(model.provider, { toolOutputStore }).execute(INPUT, toolContext()));

        const ids = toolNamesOf(presentAt(model.calls, 0));
        expect(ids.slice(-4)).toEqual(["read_tool_output", ...TERMINAL_TOOLS]);
        expect(ids.indexOf("list_available_packages")).toBe(ids.indexOf("read_tool_output") - 1);
    });

    it("declares the knowledge tools with the search tools, before the terminal tools", async () => {
        const model = blockImmediately("probe only");
        const { client } = fakeKnowledgeClient();

        await awaitOk(toolFor(model.provider, { knowledge: client }).execute(INPUT, toolContext()));

        const ids = toolNamesOf(presentAt(model.calls, 0));
        expect(ids.slice(-3)).toEqual(TERMINAL_TOOLS);
        expect(ids.indexOf("knowledge_recommend")).toBeGreaterThan(-1);
        expect(ids.indexOf("knowledge_check")).toBe(ids.indexOf("knowledge_recommend") + 1);
        expect(ids.indexOf("knowledge_check")).toBeLessThan(ids.indexOf("submit_plan"));
    });

    it("reports no reference store to the planner when none is configured", async () => {
        const model = blockImmediately("probe only");
        await awaitOk(toolFor(model.provider).execute(INPUT, toolContext()));

        expect(transcript(model)).toContain("No reference store is provisioned");
    });

    it("surfaces request_clarification as a clarification outcome", async () => {
        const model = scriptedModel([
            callTools(toolCall("t1", "request_clarification", { question: "Which two conditions should be contrasted?" })),
            reply([text("Asked.")]),
        ]);

        const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext()))._unsafeUnwrap());

        expect(result.event).toBe("clarification_needed");
        expect(result.question).toBe("Which two conditions should be contrasted?");
    });

    it("refuses a placeholder clarification and records the real question that follows", async () => {
        const model = scriptedModel([
            callTools(toolCall("t1", "request_clarification", { question: "Placeholder, not used" })),
            callTools(toolCall("t2", "request_clarification", { question: "Which two conditions should be contrasted?" })),
            reply([text("Asked.")]),
        ]);

        const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext()))._unsafeUnwrap());

        expect(result.event).toBe("clarification_needed");
        expect(result.question).toBe("Which two conditions should be contrasted?");
        const refusal = errorTextIn(presentAt(model.calls, 1), "t1");
        expect(refusal).toContain("input validation failed");
        expect(refusal).toContain("placeholder");
    });

    it("errors when the planner ends without a terminal tool call", async () => {
        // Prose on the run and on its salvage request, so no terminal outcome is ever recorded.
        const prose = reply([text("Here is a plan, described in prose.")]);
        const model = scriptedModel([prose, prose]);

        const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext()))._unsafeUnwrap());

        expect(result.event).toBe("error");
        expect(result.error).toContain("without a terminal outcome");
        expect(model.calls).toHaveLength(2);
    });

    it("gives a refused candidate its issues, and the planner submits again", async () => {
        const analysisId = "an-refused-candidate";
        await seedAnalysis(pool, analysisId, { dpStatus: null });
        const model = scriptedModel([
            callTools(submitPlan("t1", validCandidate({ depends_on: ["T9S9"] }))),
            callTools(submitPlan("t2", validCandidate())),
            submitted,
        ]);

        const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());

        expect(result.event).toBe("plan_complete");
        const refused = z
            .object({
                type: z.literal("json"),
                value: z.object({ accepted: z.literal(false), issues: z.array(z.object({ code: z.string(), message: z.string() })) }),
            })
            .parse(toolResultIn(presentAt(model.calls, 1), "t1"));
        expect(refused.value.issues.length).toBeGreaterThan(0);
        expect(refused.value.issues.every((issue) => issue.code === "semantic")).toBe(true);
        expect(JSON.stringify(refused.value.issues)).toContain("T9S9");
    });

    it("shows the card of a completed plan to the user, and a blocker shows none", async () => {
        const analysisId = "an-card";
        await seedAnalysis(pool, analysisId, { dpStatus: null });
        const emitted: unknown[] = [];
        const model = scriptedModel([callTools(submitPlan("t1", validCandidate())), submitted]);

        const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext(analysisId, { emitted })))._unsafeUnwrap());

        const cards = emitted.filter((event) => parseUnknownRecord(event)?.type === "data-plan");
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({ type: "data-plan", source: { agentId: "conversation-agent" }, data: { planId: planIdOf(result) } });

        const blockedEvents: unknown[] = [];
        (await toolFor(blockImmediately().provider).execute(INPUT, toolContext(analysisId, { emitted: blockedEvents })))._unsafeUnwrap();
        expect(blockedEvents.filter((event) => parseUnknownRecord(event)?.type === "data-plan")).toHaveLength(0);
    });

    it("persists one plan when the persist of the same call runs again, and a new call persists a new plan", async () => {
        const analysisId = "an-rerun";
        await seedAnalysis(pool, analysisId, { dpStatus: null });
        const runOnce = async (invocationId: string): Promise<PlanningAgentOutput> => {
            const model = scriptedModel([callTools(submitPlan("t1", validCandidate())), submitted]);
            return planResultOf((await toolFor(model.provider).execute(INPUT, toolContext(analysisId, { invocationId })))._unsafeUnwrap());
        };
        const planCount = async (): Promise<number> =>
            (await pool.query({ text: "SELECT plan_id FROM cortex_plans WHERE analysis_id = $1", values: [analysisId] })).rowCount ?? 0;

        const first = await runOnce("call-plan-1");
        const rerun = await runOnce("call-plan-1");

        expect(planIdOf(rerun)).toBe(planIdOf(first));
        expect(await planCount()).toBe(1);

        const other = await runOnce("call-plan-2");
        expect(planIdOf(other)).not.toBe(planIdOf(first));
        expect(await planCount()).toBe(2);
    });

    // ── Data context: the profile reaches the planner, the caller never types it ──

    describe("data context", () => {
        it("takes no dataset field from the caller at all", () => {
            const schema = z
                .object({ properties: z.record(z.string(), z.json()), required: z.array(z.string()).optional() })
                .parse(toolFor(scriptedModel([]).provider).jsonSchema);

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
            const model = blockImmediately();

            await awaitOk(toolFor(model.provider).execute(INPUT, toolContext(analysisId)));

            const seed = plannerSeed(model);
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

        /** Run the planner over one recommend call and the given submit calls, with a knowledge client. */
        async function plannedWithAnswer(analysisId: string, candidates: readonly unknown[], logger?: CapturingLogger): Promise<PlanningAgentOutput> {
            await seedAnalysis(pool, analysisId, { dpStatus: null });
            const { client } = fakeKnowledgeClient();
            const script: ScriptStep[] = [
                callTools(toolCall("t1", "knowledge_recommend", SITUATION)),
                ...candidates.map((plan, i) => callTools(submitPlan(`s${i + 1}`, plan))),
                submitted,
            ];
            const model = scriptedModel(script);
            return planResultOf((await toolFor(model.provider, { knowledge: client, logger }).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());
        }

        async function storedStepsOf(analysisId: string, result: PlanningAgentOutput) {
            expect(result.event).toBe("plan_complete");
            return storedPlan((await loadPlan(pool, planIdOf(result), { analysisId }))._unsafeUnwrap()).steps;
        }

        it("restores the template of a skeleton step that the model dropped", async () => {
            // The model copies the T1S2 skeleton step with its claims and snapshot,
            // and it leaves the template out; the host puts it back.
            const grounded = validCandidate({
                id: "T1S2",
                grounding: { status: "grounded", snapshot: SNAPSHOT.digest, claims: ["R-0001@e7d0"], reason: "DESeq2 Wald test per R-0001@e7d0" },
            });

            const steps = await storedStepsOf("an-restored-template", await plannedWithAnswer("an-restored-template", [grounded]));

            expect(steps[0]?.grounding?.template).toBe("tpl-deseq2-two-group@1.0.0");
        });

        it("stamps the snapshot digest of a skeleton step that the model miscopied", async () => {
            // The model copies the T1S2 skeleton step with its claims, and it drops
            // characters of the digest on the way; the host stamps the digest of the
            // answer, and the template restore then finds the step.
            const miscopied = validCandidate({
                id: "T1S2",
                grounding: { status: "grounded", snapshot: SNAPSHOT.digest.slice(0, 40), claims: ["R-0001@e7d0"], reason: "DESeq2 Wald test per R-0001@e7d0" },
            });

            const steps = await storedStepsOf("an-stamped-digest", await plannedWithAnswer("an-stamped-digest", [miscopied]));

            expect(steps[0]?.grounding?.snapshot).toBe(SNAPSHOT.digest);
            expect(steps[0]?.grounding?.template).toBe("tpl-deseq2-two-group@1.0.0");
        });

        it("stamps the digest of a step outside the skeleton when one of its claims is a claim of the answer, and leaves one with no such claim", async () => {
            // The model adds a robustness step under its own id, cites a claim of the
            // answer, and miscopies the digest; the claim vouches for the step, thus
            // the host stamps the digest. A second added step cites nothing of the
            // answer, and the host leaves its digest as the model wrote it.
            const base = validCandidate({
                id: "T1S2",
                grounding: { status: "grounded", snapshot: SNAPSHOT.digest, claims: ["R-0001@e7d0"], reason: "DESeq2 Wald test per R-0001@e7d0" },
            });
            const first = presentAt(base.steps, 0);
            const typed = `${SNAPSHOT.digest.slice(0, 60)}0000`;
            const plan = {
                ...base,
                steps: [
                    first,
                    {
                        ...first,
                        id: "T2S1",
                        track: "T2",
                        name: "edgeR quasi-likelihood robustness check",
                        grounding: {
                            status: "grounded",
                            snapshot: typed,
                            claims: ["R-0001@e7d0"],
                            reason: "the second method of R-0001@e7d0 for a robustness check",
                        },
                    },
                    {
                        ...first,
                        id: "T2S2",
                        track: "T2",
                        name: "Sample sheet audit",
                        grounding: { status: "ungrounded", snapshot: typed, claims: [], reason: "no rule covers the audit of the sample sheet" },
                    },
                ],
            };

            const steps = await storedStepsOf("an-stamped-outside", await plannedWithAnswer("an-stamped-outside", [plan]));

            const digestOf = (id: string) => steps.find((step) => step.id === id)?.grounding?.snapshot;
            expect(digestOf("T1S2")).toBe(SNAPSHOT.digest);
            expect(digestOf("T2S1")).toBe(SNAPSHOT.digest);
            expect(digestOf("T2S2")).toBe(typed);
        });

        it("stamps the digest of a step that departs from the answer, and restores no template", async () => {
            // The model keeps the T1S2 step of the skeleton, and it plans another
            // method with the reason. The host stamps the digest, because the step
            // consulted the answer, and it restores no template, because the
            // template realizes the method the step left.
            const departed = validCandidate({
                id: "T1S2",
                grounding: {
                    status: "ungrounded",
                    snapshot: SNAPSHOT.digest.slice(0, 40),
                    claims: [],
                    reason: "limma-voom: the design carries a continuous covariate that the vetted template does not model",
                },
            });

            const steps = await storedStepsOf("an-departed-step", await plannedWithAnswer("an-departed-step", [departed]));

            expect(steps[0]?.grounding?.status).toBe("ungrounded");
            expect(steps[0]?.grounding?.snapshot).toBe(SNAPSHOT.digest);
            expect(steps[0]?.grounding?.template).toBeUndefined();
        });

        it("repairs a claim id whose hash the model miscopied", async () => {
            // The answer returned R-0001@e7d0; the model wrote the rule with a wrong
            // hash. One snapshot holds one version of a rule, thus the host repairs it.
            const miscopied = validCandidate({
                id: "T1S2",
                grounding: {
                    status: "grounded",
                    snapshot: SNAPSHOT.digest,
                    claims: ["R-0001@e7d1", "R-0166@4d5e"],
                    reason: "DESeq2 Wald test per R-0001@e7d0",
                },
            });

            const steps = await storedStepsOf("an-repaired-claim", await plannedWithAnswer("an-repaired-claim", [miscopied]));

            expect(steps[0]?.grounding?.claims).toEqual(["R-0001@e7d0", "R-0166@4d5e"]);
        });

        it("rejects a claim the answer did not return, and accepts the corrected plan", async () => {
            const unknown = validCandidate({
                id: "T1S2",
                grounding: {
                    status: "grounded",
                    snapshot: SNAPSHOT.digest,
                    claims: ["R-0001@e7d0", "R-0999@abcd"],
                    reason: "DESeq2 Wald test per R-0001@e7d0",
                },
            });
            const corrected = validCandidate({
                id: "T1S2",
                grounding: { status: "grounded", snapshot: SNAPSHOT.digest, claims: ["R-0001@e7d0"], reason: "DESeq2 Wald test per R-0001@e7d0" },
            });
            const logger = createCapturingLogger();

            const result = await plannedWithAnswer("an-unknown-claim", [unknown, corrected], logger);

            const steps = await storedStepsOf("an-unknown-claim", result);
            const rejections = logger.records.filter((r) => r.level === "warn" && r.msg.includes("submit_plan rejected"));
            expect(rejections).toHaveLength(1);
            expect(presentAt(rejections, 0).fields).toMatchObject({ paths: ["plan.steps.0.grounding.claims.1"] });
            const finished = presentAt(
                logger.records.filter((r) => r.msg.endsWith("plan generation finished")),
                0,
            );
            expect(JSON.stringify(finished.fields.rejections)).toContain("R-0999@abcd");
            expect(steps[0]?.grounding?.claims).toEqual(["R-0001@e7d0"]);
        });

        it("leaves a step with a different snapshot as it is", async () => {
            const ungrounded = validCandidate({
                id: "T1S2",
                grounding: { status: "ungrounded", snapshot: "none", claims: [], reason: "planned from own knowledge" },
            });

            const steps = await storedStepsOf("an-other-snapshot", await plannedWithAnswer("an-other-snapshot", [ungrounded]));

            expect(steps[0]?.grounding?.snapshot).toBe("none");
            expect(steps[0]?.grounding?.template).toBeUndefined();
        });

        it("accepts a plan that the model sent as a JSON-encoded string", async () => {
            const analysisId = "an-string-plan";
            await seedAnalysis(pool, analysisId, { dpStatus: null });
            // A small model on a large nested schema encodes the object as a string.
            // The permissive arg schema accepts the string, thus the loop repair never
            // runs, and the planner decodes it before its own validation.
            const model = scriptedModel([callTools(submitPlan("t1", JSON.stringify(validCandidate()))), submitted]);

            const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());

            expect(result.event).toBe("plan_complete");
            expect(result.planId).toMatch(PLAN_ID_RE);
        });

        it("plans without a profile: no data-context section, and the plan still lands", async () => {
            const analysisId = "an-unprofiled";
            // A real analysis with a NULL profile status — the honest "never profiled"
            // state `loadDataProfileStatus` collapses to null.
            await seedAnalysis(pool, analysisId, { dpStatus: null });
            const model = scriptedModel([callTools(submitPlan("t1", validCandidate())), submitted]);

            const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());

            // Planning proceeds to a persisted plan — a missing profile costs grounding,
            // never the plan.
            expect(result.event).toBe("plan_complete");
            expect(result.planId).toMatch(PLAN_ID_RE);

            const seed = plannerSeed(model);
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
            // The seed names a file the stored profile never covered. Re-profiling is
            // invoked by the embedder that owns the input mutation, so a row still
            // reading `completed` is a row nothing has superseded.
            await seedAnalysis(pool, analysisId, {
                dpStatus: "completed",
                result: RICH_PROFILE,
                seed: ["file-aaa", "file-bbb", "file-ccc"],
            });
            const model = blockImmediately();

            await awaitOk(toolFor(model.provider).execute(INPUT, toolContext(analysisId)));

            const context = dataContextBlock(plannerSeed(model));
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
            const model = blockImmediately();

            await awaitOk(toolFor(model.provider).execute(INPUT, toolContext(analysisId)));

            const context = dataContextBlock(plannerSeed(model));
            expect(context).toContain("PROVISIONAL");
            expect(context).toContain("re-profile is in progress");
            expect(context).toContain("Homo sapiens (taxon 9606)");
        });

        it("says so in the seed when profiling is still running and has produced nothing yet", async () => {
            const analysisId = "an-pending";
            await seedAnalysis(pool, analysisId, { dpStatus: "running", result: null, seed: ["file-aaa"] });
            const model = blockImmediately();

            await awaitOk(toolFor(model.provider).execute(INPUT, toolContext(analysisId)));

            const context = dataContextBlock(plannerSeed(model));
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
            const model = blockImmediately();

            await awaitOk(toolFor(model.provider).execute(INPUT, toolContext(analysisId)));

            const context = dataContextBlock(plannerSeed(model));
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
            const model = blockImmediately();
            const note = "Samples 3 and 7 were re-sequenced; treat batch B as the reference.";

            await awaitOk(toolFor(model.provider).execute({ ...INPUT, analystNotes: note }, toolContext(analysisId)));

            const seed = plannerSeed(model);
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

    // ── The call guard of the search tools ───────────────────────────

    describe("the call guard", () => {
        const refs = (id: string, query: string) => toolCall(id, "list_available_refs", { query });

        /** The guard refusals that the planner logged. */
        const guardRefusals = (logger: CapturingLogger): CapturedLog[] => logger.records.filter((r) => r.msg.endsWith("planner call refused by the guard"));

        it("refuses the third call with an identical input, runs no listing for it, and the run continues", async () => {
            const analysisId = "an-guard-identical";
            await seedAnalysis(pool, analysisId, { dpStatus: null });
            const model = scriptedModel([
                callTools(refs("r1", "hallmark"), refs("r2", "hallmark"), refs("r3", "hallmark")),
                callTools(submitPlan("t1", validCandidate())),
                submitted,
            ]);
            const logger = createCapturingLogger();

            const result = planResultOf((await toolFor(model.provider, { logger }).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());

            expect(result.event).toBe("plan_complete");
            const answer = presentAt(model.calls, 1);
            expect(z.object({ type: z.literal("json") }).safeParse(toolResultIn(answer, "r1")).success).toBe(true);
            expect(z.object({ type: z.literal("json") }).safeParse(toolResultIn(answer, "r2")).success).toBe(true);
            expect(errorTextIn(answer, "r3")).toContain("already called list_available_refs with this exact input 2 times");
            expect(guardRefusals(logger)).toHaveLength(1);
            expect(presentAt(guardRefusals(logger), 0).fields).toMatchObject({ tool: "list_available_refs", kind: "identical", calls: 3 });
        });

        it("refuses the call past the budget of one tool", async () => {
            const analysisId = "an-guard-budget";
            await seedAnalysis(pool, analysisId, { dpStatus: null });
            const packages = Array.from({ length: 13 }, (_, i) => toolCall(`p${i + 1}`, "list_available_packages", { query: `package-${i + 1}` }));
            const model = scriptedModel([callTools(...packages), callTools(submitPlan("t1", validCandidate())), submitted]);

            const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());

            expect(result.event).toBe("plan_complete");
            const answer = presentAt(model.calls, 1);
            expect(z.object({ type: z.literal("json") }).safeParse(toolResultIn(answer, "p12")).success).toBe(true);
            expect(errorTextIn(answer, "p13")).toContain("made 12 calls of list_available_packages, which is the budget of one run for one tool");
        });

        it("never refuses a terminal tool, also past the total budget of the run", async () => {
            const analysisId = "an-guard-total";
            await seedAnalysis(pool, analysisId, { dpStatus: null });
            const { client } = fakeKnowledgeClient();
            // Forty calls with distinct inputs, each tool inside its own budget, reach the total budget.
            const searches = [
                ...Array.from({ length: 12 }, (_, i) => refs(`r${i + 1}`, `collection-${i + 1}`)),
                ...Array.from({ length: 12 }, (_, i) => toolCall(`p${i + 1}`, "list_available_packages", { query: `package-${i + 1}` })),
                ...Array.from({ length: 12 }, (_, i) => toolCall(`k${i + 1}`, "knowledge_recommend", { ...SITUATION, n_per_group_max: 6 + i })),
                ...Array.from({ length: 4 }, (_, i) =>
                    toolCall(`c${i + 1}`, "knowledge_check", { ...SITUATION, steps: [{ step_type: "differential_expression", method: `method-${i + 1}` }] }),
                ),
            ];
            const model = scriptedModel([callTools(...searches), callTools(refs("r13", "collection-13"), submitPlan("t1", validCandidate())), submitted]);

            const result = planResultOf((await toolFor(model.provider, { knowledge: client }).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());

            expect(result.event).toBe("plan_complete");
            const answer = presentAt(model.calls, 2);
            expect(errorTextIn(answer, "r13")).toContain("made 40 calls across its search tools");
            expect(z.object({ type: z.literal("json"), value: z.object({ accepted: z.literal(true) }) }).safeParse(toolResultIn(answer, "t1")).success).toBe(
                true,
            );
        });

        it("refuses the same calls when the same calls run again, as a replay does", async () => {
            const refusedIn = async (analysisId: string): Promise<string[]> => {
                await seedAnalysis(pool, analysisId, { dpStatus: null });
                const ids = ["r1", "r2", "r3", "r4"];
                const model = scriptedModel([
                    callTools(...ids.map((id) => refs(id, "hallmark"))),
                    callTools(refs("r5", "hallmark"), refs("r6", "msigdb"), toolCall("b1", "report_blocker", { reason: "No collection fits the question." })),
                    reported,
                ]);
                const result = planResultOf((await toolFor(model.provider).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());
                expect(result.event).toBe("error");
                expect(model.calls).toHaveLength(3);
                const last = presentAt(model.calls, 2);
                return [...ids, "r5", "r6"].filter((id) => ErrorTextSchema.safeParse(toolResultIn(last, id)).success);
            };

            const first = await refusedIn("an-guard-replay-1");
            const replay = await refusedIn("an-guard-replay-2");

            expect(first).toEqual(["r3", "r4", "r5"]);
            expect(replay).toEqual(first);
        });

        it("ends the search after six refusals, and the salvage lets only the terminal tools run", async () => {
            const analysisId = "an-guard-looping";
            await seedAnalysis(pool, analysisId, { dpStatus: null });
            // Two calls run, and the six after them are refused.
            const looping = Array.from({ length: 8 }, (_, i) => refs(`r${i + 1}`, "hallmark"));
            const model = scriptedModel([callTools(...looping), callTools(refs("r9", "another collection"), submitPlan("t1", validCandidate())), submitted]);
            const logger = createCapturingLogger();

            const result = planResultOf((await toolFor(model.provider, { logger }).execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());

            expect(result.event).toBe("plan_complete");
            expect(guardRefusals(logger)).toHaveLength(6);
            // The run stopped at the refusal limit, far before the step cap.
            expect(model.calls).toHaveLength(3);
            const salvage = presentAt(model.calls, 2);
            expect(errorTextIn(salvage, "r9")).toContain(
                "The tool list_available_refs is not available for this request, thus it did not run. The tools that can run now: submit_plan, request_clarification, report_blocker.",
            );
            const finished = presentAt(
                logger.records.filter((r) => r.msg.endsWith("plan generation finished")),
                0,
            );
            expect(finished.fields.loop).toMatchObject({ salvaged: true, firstFinishReason: "max_iterations" });
        });
    });

    // ── Diagnostic records ───────────────────────────────────────────
    //
    // This tool returns `ok(...)` for every ending, so the return value distinguishes
    // nothing about how an invocation went. It also writes no ledger row and owns no
    // durable stream. The record is therefore the only evidence that survives the
    // turn, which is what these assertions protect.

    describe("outcome records", () => {
        function loggedToolFor(model: ScriptedModel): { tool: Tool; logger: CapturingLogger } {
            const logger = createCapturingLogger();
            return { tool: toolFor(model.provider, { logger }), logger };
        }

        /** The one per-invocation outcome record, failing loudly if there is not exactly one. */
        function outcomeRecord(logger: CapturingLogger): CapturedLog {
            const records = logger.records.filter((r) => r.msg.endsWith("plan generation finished"));
            expect(records).toHaveLength(1);
            return presentAt(records, 0);
        }

        it("records a submitted plan once, at info, with the elapsed time and analysis", async () => {
            const analysisId = "an-log-ok";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            const { tool, logger } = loggedToolFor(scriptedModel([callTools(submitPlan("t1", validCandidate())), submitted]));

            const result = planResultOf((await tool.execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());
            expect(result.event).toBe("plan_complete");

            const record = outcomeRecord(logger);
            expect(record.level).toBe("info");
            expect(record.fields).toMatchObject({ outcome: "plan_submitted", analysisId });
            expect(typeof record.fields.elapsedMs).toBe("number");
        });

        it("records a clarification request at info — the tool working as designed", async () => {
            const { tool, logger } = loggedToolFor(
                scriptedModel([callTools(toolCall("t1", "request_clarification", { question: "Which contrast?" })), reply([text("Asked.")])]),
            );

            await awaitOk(tool.execute(INPUT, toolContext()));

            const record = outcomeRecord(logger);
            expect(record.level).toBe("info");
            expect(record.fields).toMatchObject({ outcome: "clarification" });
        });

        it("records a blocker at warn — a real answer that cost the user their plan", async () => {
            const { tool, logger } = loggedToolFor(blockImmediately());

            await awaitOk(tool.execute(INPUT, toolContext()));

            const record = outcomeRecord(logger);
            expect(record.level).toBe("warn");
            expect(record.fields).toMatchObject({ outcome: "blocker" });
        });

        it("refuses a parentPlanId that is not a plan of this analysis, before the planner runs", async () => {
            const analysisId = "an-parent-plan-classified";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            const model = scriptedModel([reply([text("never reached")])]);
            const { tool, logger } = loggedToolFor(model);

            const result = planResultOf((await tool.execute({ ...INPUT, parentPlanId: "pln-00000000" }, toolContext(analysisId)))._unsafeUnwrap());

            expect(result.event).toBe("error");
            expect(result.error).toBe("parentPlanId is not a valid plan for this analysis");
            const record = outcomeRecord(logger);
            expect(record.level).toBe("warn");
            expect(record.fields).toMatchObject({ outcome: "invalid_parent_plan" });
            expect(model.calls).toHaveLength(0);
        });

        it("distinguishes the failure shapes rather than collapsing them to one error", async () => {
            // Ends on prose without ever recording an outcome — the salvage turn also
            // declines, so the invocation finishes with nothing submitted.
            const prose = reply([text("thinking out loud")]);
            const { tool, logger } = loggedToolFor(scriptedModel([prose, prose]));

            await awaitOk(tool.execute(INPUT, toolContext()));

            const record = outcomeRecord(logger);
            expect(record.level).toBe("error");
            expect(record.fields).toMatchObject({ outcome: "no_outcome" });

            // A different failure carries a different kind, so the two are separable in a
            // log query — the whole reason the tool records a kind and not just "failed".
            const cancelled = createCapturingLogger();
            const aborted = new AbortController();
            aborted.abort();
            await awaitOk(
                toolFor(scriptedModel([]).provider, { logger: cancelled }).execute(INPUT, {
                    ...toolContext(),
                    signal: aborted.signal,
                }),
            );

            const cancelledRecord = presentAt(
                cancelled.records.filter((r) => r.msg.endsWith("plan generation finished")),
                0,
            );
            expect(cancelledRecord.fields.outcome).toBe("cancelled");
            expect(cancelledRecord.fields.outcome).not.toBe(record.fields.outcome);
        });

        it("records a submit that fails re-validation, which is the rejection that costs an iteration", async () => {
            // A dangling `depends_on` passes the strict arg schema and fails the semantic
            // checks, so `execute` runs and rejects — the path a schema-level bounce at the
            // loop's input boundary would never reach.
            const { tool, logger } = loggedToolFor(
                scriptedModel([
                    callTools(submitPlan("t1", validCandidate({ depends_on: ["T9S9"] }))),
                    callTools(toolCall("t2", "report_blocker", { reason: "cannot fix" })),
                    reported,
                ]),
            );

            await awaitOk(tool.execute(INPUT, toolContext()));

            // `warn`, not `debug`: a rejection costs an iteration and is otherwise unreported,
            // so it must survive the default level a host actually runs at.
            const rejection = logger.records.filter((r) => r.level === "warn" && r.msg.includes("submit_plan rejected"));
            expect(rejection).toHaveLength(1);
            expect(presentAt(rejection, 0).fields.issueCount).toBeGreaterThan(0);
            expect(presentAt(rejection, 0).fields.paths).toEqual(["plan"]);

            const rejections = z
                .array(
                    z.object({
                        attempt: z.number(),
                        codes: z.object({ schema: z.number(), semantic: z.number() }),
                        paths: z.array(z.string()),
                        messages: z.array(z.string()),
                    }),
                )
                .parse(outcomeRecord(logger).fields.rejections);
            expect(rejections).toHaveLength(1);
            expect(presentAt(rejections, 0)).toMatchObject({ attempt: 1, codes: { schema: 0, semantic: 1 }, paths: ["plan"] });
            expect(presentAt(rejections, 0).messages).toBeArrayOfSize(1);
        });

        it("records no rejection when the first submit is accepted", async () => {
            const accepted = loggedToolFor(scriptedModel([callTools(submitPlan("t1", validCandidate())), submitted]));

            await awaitOk(accepted.tool.execute(INPUT, toolContext("an-log-accept")));

            expect(accepted.logger.records.filter((r) => r.msg.includes("rejected"))).toHaveLength(0);
        });

        it("opens with a seed census, so a run that never returns can be weighed against what it was handed", async () => {
            const analysisId = "an-log-seed";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            const { tool, logger } = loggedToolFor(blockImmediately());

            await awaitOk(tool.execute({ ...INPUT, userConstraints: "Use limma-voom." }, toolContext(analysisId)));

            const started = logger.records.filter((r) => r.msg.endsWith("plan generation started"));
            expect(started).toHaveLength(1);
            expect(presentAt(started, 0).level).toBe("info");
            expect(presentAt(started, 0).fields).toMatchObject({ grounding: "ready", analysisId });

            // Sizes, never content: the seed carries the research question and the dataset's
            // facts, which belong in the model's context and not in a log file.
            const seedChars = z.record(z.string(), z.number()).parse(presentAt(started, 0).fields.seedChars);
            expect(seedChars.total).toBeGreaterThan(0);
            expect(seedChars.dataContext).toBeGreaterThan(0);
            expect(seedChars.userConstraints).toBe("Use limma-voom.".length);
            expect(seedChars.priorRuns).toBe(0);
            const census = JSON.stringify(presentAt(started, 0).fields);
            expect(census).not.toContain(INPUT.researchQuestion);
            expect(census).not.toContain("limma-voom");
        });

        it("carries the loop account on a run that ended with no terminal outcome", async () => {
            // The reported failure: three identical `no_outcome` returns taught nobody
            // anything, because the word covers a budget spent on rejected submits, a planner
            // answering in prose, and a reply cut off mid-tool-call alike.
            const prose = reply([text("Let me think about this out loud.")]);
            const { tool, logger } = loggedToolFor(scriptedModel([prose, prose]));

            await awaitOk(tool.execute(INPUT, toolContext()));

            const record = outcomeRecord(logger);
            expect(record.fields.outcome).toBe("no_outcome");
            expect(record.fields.loop).toMatchObject({ finishReason: "stop", salvaged: true, firstFinishReason: "stop", toolCalls: [] });
            // The planner's last words — the single artifact that explains a run which stopped
            // talking instead of calling a terminal tool, and which nothing else preserves.
            const authored = parseUnknownRecord(record.fields.modelAuthored);
            if (authored === undefined) throw new Error("the outcome carries no model-authored record");
            if (!("plannerFinalProse" in authored)) throw new Error("the model-authored record carries no planner prose");
            expect(authored.plannerFinalProse).toContain("think about this out loud");
        });

        it("nests model prose under one key and omits it where something else explains the outcome", async () => {
            const analysisId = "an-log-prose";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            // A real planner narrates alongside its tool call, and that narration quotes the
            // dataset it was handed. On a submitted plan nothing needs it: the terminal tool
            // already recorded what was decided, so the prose would be model output describing
            // the user's data sitting in a record that has no use for it.
            const { tool, logger } = loggedToolFor(
                scriptedModel([
                    {
                        content: [{ type: "text", text: "These are atopic dermatitis skin biopsies; S7 is a QC outlier." }, submitPlan("t1", validCandidate())],
                        finishReason: "tool-calls",
                    },
                    submitted,
                ]),
            );

            const result = planResultOf((await tool.execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());
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
            // Every request submits a plan whose `depends_on` names a step that does not exist:
            // schema-valid, semantically impossible, rejected forever. This is the shape that
            // burns the whole step cap and its salvage with no accepted plan.
            const thrash = Array.from({ length: 303 }, (_, i) => callTools(submitPlan(`t${i}`, validCandidate({ depends_on: ["T9S9"] }))));
            const { tool, logger } = loggedToolFor(scriptedModel(thrash));

            const result = planResultOf((await tool.execute(INPUT, toolContext(analysisId)))._unsafeUnwrap());
            expect(result.event).toBe("error");

            const record = outcomeRecord(logger);
            expect(record.fields.outcome).toBe("no_outcome");
            expect(record.fields.submitAttempts).toBeGreaterThan(1);
            expect(record.fields.rejectedAttempts).toBeGreaterThan(1);
            expect(record.fields.loop).toMatchObject({ finishReason: "max_iterations", cappedOut: true, salvaged: true, firstFinishReason: "max_iterations" });
            expect(z.object({ toolCalls: z.array(z.string()) }).parse(record.fields.loop).toolCalls).toContain("submit_plan");

            // Identical `paths` across attempts is the planner stuck on one fault — the
            // difference between "give it more budget" and "the plan can never be made valid".
            const rejections = z.array(z.object({ attempt: z.number(), paths: z.array(z.string()) })).parse(record.fields.rejections);
            expect(rejections.length).toBeGreaterThan(1);
            expect(presentAt(rejections, 0).attempt).toBe(1);
            expect(presentAt(rejections, 0).paths).toEqual(presentAt(rejections, 1).paths);

            // The kept rejections are capped, the COUNT is not. A record pairing 16 attempts
            // with 6 rejections reads as ten accepted plans — the opposite of what happened —
            // so the truncation is stated and the count stays whole.
            expect(record.fields.rejectedAttempts).toBe(record.fields.submitAttempts);
            expect(rejections.length).toBeLessThan(z.number().parse(record.fields.rejectedAttempts));
            expect(record.fields.rejectionsTruncated).toBe(true);
        });

        it("names the attempt a plan was accepted on — a success that nearly was not one", async () => {
            const analysisId = "an-log-late";
            await seedAnalysis(pool, analysisId, { dpStatus: "completed", result: RICH_PROFILE, seed: SEED_FILE_IDS });
            const { tool, logger } = loggedToolFor(
                scriptedModel([
                    callTools(submitPlan("t1", validCandidate({ depends_on: ["T9S9"] }))),
                    callTools(submitPlan("t2", validCandidate())),
                    submitted,
                ]),
            );

            await awaitOk(tool.execute(INPUT, toolContext(analysisId)));

            const accepted = logger.records.filter((r) => r.msg.endsWith("submit_plan accepted a plan"));
            expect(accepted).toHaveLength(1);
            expect(presentAt(accepted, 0).fields).toMatchObject({ stepCount: 1 });

            const record = outcomeRecord(logger);
            expect(record.fields).toMatchObject({ outcome: "plan_submitted", submitAttempts: 2, rejectedAttempts: 1 });
            expect(
                z
                    .array(z.object({ attempt: z.number() }))
                    .parse(record.fields.rejections)
                    .map((rejection) => rejection.attempt),
            ).toEqual([1]);
        });

        it("reports a blocker with the attempt count, separating giving up from never trying", async () => {
            const { tool, logger } = loggedToolFor(blockImmediately());

            await awaitOk(tool.execute(INPUT, toolContext()));

            const record = outcomeRecord(logger);
            expect(record.level).toBe("warn");
            expect(record.fields).toMatchObject({ outcome: "blocker", submitAttempts: 0, rejectedAttempts: 0 });
            // A loose `reason` would collide with the loop's structural `reason` (its finish
            // reason) in any sink that filters by name.
            expect(record.fields).not.toHaveProperty("reason");
        });
    });
});
