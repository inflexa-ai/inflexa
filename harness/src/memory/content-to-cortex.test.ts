import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

// Imported through the PUBLIC package specifiers a consumer would use, not the
// relative paths the rest of this file uses for harness-internal helpers — the
// rollup is shipped for an embedder, and a type it cannot import is not delivered.
import type { CortexMessage } from "@inflexa-ai/harness/contracts/message.js";
import type { TokenUsageRollup } from "@inflexa-ai/harness/contracts/usage.js";

import { withSchema } from "../__tests__/setup/postgres.js";
import { insertPlan, upsertPlan } from "../state/plans.js";
import { insertRun } from "../state/runs.js";
import { adHocPlanId, adHocRunId } from "../tools/analysis-invocation.js";
import { defineTool } from "../tools/define-tool.js";
import { createDetailResolver } from "../tools/detail-resolver.js";
import { envelopeMessage, markInterruptedMessage, syntheticRecordMessage, syntheticUserMessage } from "./ai-sdk-message-storage.js";
import { contentToCortexMessages } from "./content-to-cortex.js";
import { createCardResolver } from "./reconstruct-cards.js";
import { createThreadHistory, type StoredMessage, type ThreadHistory } from "./thread-history.js";

const THREAD = "thread-convert-1";

let pool: Pool;
let drop: () => Promise<void>;
let history: ThreadHistory;

function stored(seq: number, message: ModelMessage, usage?: TokenUsageRollup): StoredMessage {
    return { seq, envelope: envelopeMessage(message), message, ...(usage === undefined ? {} : { usage }) };
}

beforeEach(async () => {
    ({ pool, drop } = await withSchema("content-to-cortex"));
    history = createThreadHistory(pool);
});

afterEach(async () => {
    await drop?.();
});

describe("contentToCortexMessages", () => {
    it("round-trips an appendTurn turn, drops reasoning + tool-result, leaves storage unchanged (3.3)", async () => {
        const turn: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Run PCA" }] },
            {
                role: "assistant",
                content: [
                    { type: "reasoning", text: "secret reasoning", providerOptions: { anthropic: { signature: "sig" } } },
                    { type: "text", text: "Sure, running it." },
                    { type: "tool-call", toolCallId: "call-1", toolName: "run_pca", input: { k: 2 } },
                ],
            },
            {
                role: "tool",
                content: [{ type: "tool-result", toolCallId: "call-1", toolName: "run_pca", output: { type: "text", value: "done" } }],
            },
            { role: "assistant", content: [{ type: "text", text: "Here are the results." }] },
        ];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        const page = (await history.loadPage(THREAD, 0, 100))._unsafeUnwrap();
        const cortex = await contentToCortexMessages(page.messages);

        // The tool-result-only tool message is dropped (no renderable parts), and
        // the two assistant rows it separated are coalesced into one turn — matching
        // the live SSE shape of one assistant bubble per turn.
        expect(cortex.map((m) => m.role)).toEqual(["user", "assistant"]);

        expect(cortex[0]!.parts).toEqual([{ type: "text", text: "Run PCA" }]);

        // Reasoning dropped; text + tool-call from the first assistant row and the
        // post-tool-result text from the second are merged in order.
        expect(cortex[1]!.parts).toEqual([
            { type: "text", text: "Sure, running it." },
            { type: "tool-call", toolCallId: "call-1", toolName: "run_pca", status: "finished", outcome: "ok" },
            { type: "text", text: "Here are the results." },
        ]);

        // Storage is unchanged — the reasoning block with provider metadata still
        // lives in the stored envelope.
        const { rows } = await pool.query<{ message_envelope: { message: { content: unknown } } }>(
            "SELECT message_envelope FROM messages WHERE thread_id = $1 AND seq = 1",
            [THREAD],
        );
        const stored = rows[0]!.message_envelope.message.content as Array<{ type: string; providerOptions?: { anthropic?: { signature?: string } } }>;
        const reasoning = stored.find((b) => b.type === "reasoning");
        expect(reasoning).toBeDefined();
        expect(reasoning!.providerOptions?.anthropic?.signature).toBe("sig");
    });

    it("coalesces a run of serial single-tool-call assistant steps into one turn", async () => {
        // The agent loop persists serial tool use as one assistant row per step,
        // each followed by a tool-result row. Reconstruction must fold the
        // whole run into a single assistant message (one bubble, one tool group) —
        // not a stack of single-tool messages.
        const turn: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "Build a report" }] }];
        for (let i = 0; i < 5; i++) {
            turn.push({
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: `call-${i}`, toolName: "read_file", input: { i } }],
            });
            turn.push({
                role: "tool",
                content: [{ type: "tool-result", toolCallId: `call-${i}`, toolName: "read_file", output: { type: "text", value: "ok" } }],
            });
        }
        turn.push({ role: "assistant", content: [{ type: "text", text: "Here is the report." }] });
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        const page = (await history.loadPage(THREAD, 0, 100))._unsafeUnwrap();
        const cortex = await contentToCortexMessages(page.messages);

        // One user bubble + one assistant bubble for the whole turn.
        expect(cortex.map((m) => m.role)).toEqual(["user", "assistant"]);

        // All five tool calls plus the trailing text live in the one assistant message.
        expect(cortex[1]!.parts).toEqual([
            { type: "tool-call", toolCallId: "call-0", toolName: "read_file", status: "finished", outcome: "ok" },
            { type: "tool-call", toolCallId: "call-1", toolName: "read_file", status: "finished", outcome: "ok" },
            { type: "tool-call", toolCallId: "call-2", toolName: "read_file", status: "finished", outcome: "ok" },
            { type: "tool-call", toolCallId: "call-3", toolName: "read_file", status: "finished", outcome: "ok" },
            { type: "tool-call", toolCallId: "call-4", toolName: "read_file", status: "finished", outcome: "ok" },
            { type: "text", text: "Here is the report." },
        ]);
    });

    it("converts a bare-string content row to a single text part", async () => {
        const cortex = await contentToCortexMessages([stored(0, { role: "user", content: "hello" })]);
        expect(cortex).toEqual([{ id: "0", role: "user", parts: [{ type: "text", text: "hello" }] }]);
    });

    it("keeps adjacent user rows as two separate messages, never one merged bubble", async () => {
        // Two consecutive user rows arise from an aborted turn's lone user message
        // followed by the next turn's user message; merging them would fabricate a
        // message the user never sent.
        const cortex = await contentToCortexMessages([
            stored(0, { role: "user", content: "first question" }),
            stored(1, { role: "user", content: "second question" }),
        ]);
        expect(cortex).toEqual([
            { id: "0", role: "user", parts: [{ type: "text", text: "first question" }] },
            { id: "1", role: "user", parts: [{ type: "text", text: "second question" }] },
        ]);
    });

    it("skips the loop's truncation nudge so it never renders, coalescing the surrounding assistant rows", async () => {
        // The nudge continues a reply truncated at the output-token limit. It carries
        // the `user` role only for the wire, so it must not become a user bubble; the
        // assistant rows around it become adjacent and fold into one message.
        const cortex = await contentToCortexMessages([
            stored(0, { role: "assistant", content: [{ type: "text", text: "first half" }] }),
            stored(1, syntheticUserMessage("Continue.")),
            stored(2, { role: "assistant", content: [{ type: "text", text: "second half" }] }),
        ]);

        expect(cortex).toHaveLength(1);
        expect(cortex[0]!.role).toBe("assistant");
        expect(cortex[0]!.parts).toEqual([
            { type: "text", text: "first half" },
            { type: "text", text: "second half" },
        ]);
        expect(cortex.some((m) => m.role === "user")).toBe(false);
    });

    it("renders a host-appended record as a system message rather than dropping it", async () => {
        // The counterpart to the nudge above, and the reason the two markers exist separately. A
        // record is equally synthetic for every turn-boundary reader, but it is a FACT the reader is
        // entitled to see — the only trace in the conversation that out-of-band work happened. It
        // must not be dropped as loop machinery, and must not be attributed to the user either.
        const cortex = await contentToCortexMessages([
            stored(0, { role: "user", content: "run the plan" }),
            stored(1, { role: "assistant", content: [{ type: "text", text: "launched" }] }),
            stored(2, syntheticRecordMessage('Analysis run "DE" (run-a) completed after 2m30s.')),
        ]);

        expect(cortex).toHaveLength(3);
        expect(cortex[2]!.role).toBe("system");
        expect(cortex[2]!.parts).toEqual([{ type: "text", text: 'Analysis run "DE" (run-a) completed after 2m30s.' }]);
        // Emphatically not the user: rendering it as one would attribute system-authored text to the
        // reader and mislead them about what they can retract.
        expect(cortex.filter((m) => m.role === "user")).toHaveLength(1);
    });

    it("recognises a record structurally, even when its prose reads like a user message", async () => {
        // Recognition reads the harness marker, never the text — so a record whose wording happens to
        // resemble ordinary user prose is still a record.
        const cortex = await contentToCortexMessages([stored(0, syntheticRecordMessage("did the run finish yet?"))]);
        expect(cortex).toHaveLength(1);
        expect(cortex[0]!.role).toBe("system");
    });

    it("a record does not coalesce into an adjacent assistant run", async () => {
        // Only assistant rows coalesce; a record standing between two of them keeps them apart, which
        // is right — the outcome happened between those replies, and folding it away would lose that.
        const cortex = await contentToCortexMessages([
            stored(0, { role: "assistant", content: [{ type: "text", text: "before" }] }),
            stored(1, syntheticRecordMessage("run finished")),
            stored(2, { role: "assistant", content: [{ type: "text", text: "after" }] }),
        ]);
        expect(cortex.map((m) => m.role)).toEqual(["assistant", "system", "assistant"]);
    });

    it("sets interrupted:true on a coalesced assistant run when any row carries the marker", async () => {
        const cortex = await contentToCortexMessages([
            stored(0, { role: "assistant", content: [{ type: "text", text: "step one" }] }),
            stored(1, markInterruptedMessage({ role: "assistant", content: [{ type: "text", text: "cut off here" }] })),
        ]);

        expect(cortex).toHaveLength(1);
        expect(cortex[0]!.role).toBe("assistant");
        expect(cortex[0]!.interrupted).toBe(true);
        // The run still coalesces into one bubble carrying both rows' parts.
        expect(cortex[0]!.parts).toEqual([
            { type: "text", text: "step one" },
            { type: "text", text: "cut off here" },
        ]);
    });

    it("folds interrupted onto the prior assistant run when a marked row renders no parts", async () => {
        // A marked assistant row whose only content is non-renderable (a reasoning block)
        // drops to zero parts, but the interruption is a real fact that must land on the
        // assistant run it trailed rather than vanish with the dropped row.
        const cortex = await contentToCortexMessages([
            stored(0, { role: "assistant", content: [{ type: "text", text: "step one" }] }),
            stored(
                1,
                markInterruptedMessage({
                    role: "assistant",
                    content: [{ type: "reasoning", text: "cut off mid-thought", providerOptions: { anthropic: { signature: "sig" } } }],
                }),
            ),
        ]);

        expect(cortex).toHaveLength(1);
        expect(cortex[0]!.role).toBe("assistant");
        expect(cortex[0]!.interrupted).toBe(true);
        // The reasoning-only row contributes no parts; the run keeps only the rendered text.
        expect(cortex[0]!.parts).toEqual([{ type: "text", text: "step one" }]);
    });

    it("sets interrupted:true on a standalone marked assistant message", async () => {
        const cortex = await contentToCortexMessages([
            stored(0, { role: "user", content: "go" }),
            stored(1, markInterruptedMessage({ role: "assistant", content: "partial reply" })),
        ]);

        expect(cortex[1]!.interrupted).toBe(true);
        expect(cortex[1]!.parts).toEqual([{ type: "text", text: "partial reply" }]);
    });

    it("omits the interrupted field entirely on unmarked messages", async () => {
        const cortex = await contentToCortexMessages([
            stored(0, { role: "user", content: "hi" }),
            stored(1, { role: "assistant", content: [{ type: "text", text: "hello" }] }),
        ]);

        expect(cortex).toHaveLength(2);
        expect("interrupted" in cortex[0]!).toBe(false);
        expect("interrupted" in cortex[1]!).toBe(false);
    });

    it("carries a stored rollup onto the message its row produces", async () => {
        const usage: TokenUsageRollup = { inputTokens: 1200, outputTokens: 340 };
        const cortex = await contentToCortexMessages([
            stored(0, { role: "user", content: "run it" }),
            stored(1, { role: "assistant", content: [{ type: "text", text: "done" }] }, usage),
        ]);

        expect(cortex[1]!.usage).toEqual(usage);
        // The user's own message never carries the turn's cost — it did not incur it.
        expect("usage" in cortex[0]!).toBe(false);
    });

    it("keeps the rollup its last row carried when an assistant run is coalesced", async () => {
        // Coalescing is what rebuilds the one-bubble-per-turn shape, and the rollup
        // rides the turn's last assistant row — so the merged bubble must keep it.
        const usage: TokenUsageRollup = { inputTokens: 1200, outputTokens: 340 };
        const cortex = await contentToCortexMessages([
            stored(0, { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "run_pca", input: {} }] }),
            stored(1, { role: "assistant", content: [{ type: "text", text: "here are the results" }] }, usage),
        ]);

        expect(cortex).toHaveLength(1);
        expect(cortex[0]!.usage).toEqual(usage);
    });

    it("folds the rollup onto the prior assistant run when its row renders no parts", async () => {
        // Same reasoning as the interruption fold above: the rollup is a fact about
        // the TURN, not about what the row renders, so a last assistant row holding
        // only non-renderable content must not take the figure down with it — that
        // disappearance is exactly what persisting the rollup exists to fix.
        const usage: TokenUsageRollup = { inputTokens: 1200, outputTokens: 340 };
        const cortex = await contentToCortexMessages([
            stored(0, { role: "assistant", content: [{ type: "text", text: "here are the results" }] }),
            stored(
                1,
                { role: "assistant", content: [{ type: "reasoning", text: "wrapping up", providerOptions: { anthropic: { signature: "sig" } } }] },
                usage,
            ),
        ]);

        expect(cortex).toHaveLength(1);
        expect(cortex[0]!.usage).toEqual(usage);
        expect(cortex[0]!.parts).toEqual([{ type: "text", text: "here are the results" }]);
    });

    it("omits the usage field entirely on rows stored without a rollup", async () => {
        const cortex = await contentToCortexMessages([
            stored(0, { role: "user", content: "hi" }),
            stored(1, { role: "assistant", content: [{ type: "text", text: "hello" }] }),
        ]);

        expect(cortex).toHaveLength(2);
        expect("usage" in cortex[0]!).toBe(false);
        expect("usage" in cortex[1]!).toBe(false);
    });

    it("delivers a reloaded turn's rollup end to end, through the public message type", async () => {
        // The whole point, exercised the way an embedder meets it: append with the
        // rollup `AgentFinish.turnUsage` carried, reload, and read the figure off the
        // `CortexMessage` — no second query, no correlation, no host-side ledger.
        const usage: TokenUsageRollup = { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 900 };
        const turn: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Run PCA" }] },
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "run_pca", input: { k: 2 } }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "run_pca", output: { type: "text", value: "ok" } }] },
            { role: "assistant", content: [{ type: "text", text: "Here are the results." }] },
        ];
        (await history.appendTurn(THREAD, turn, usage))._unsafeUnwrap();

        const page = (await history.loadPage(THREAD, 0, 100))._unsafeUnwrap();
        const cortex: CortexMessage[] = await contentToCortexMessages(page.messages);

        expect(cortex.map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(cortex[1]!.usage).toEqual(usage);
    });

    it("reconstructs a display card from a tool-call block via resolveCard", async () => {
        const cortex = await contentToCortexMessages(
            [
                stored(0, {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Here's the plan." },
                        { type: "tool-call", toolCallId: "call-9", toolName: "show_plan", input: { planId: "pln-abc12345" } },
                        { type: "tool-call", toolCallId: "call-10", toolName: "run_pca", input: {} },
                    ],
                }),
            ],
            {
                // Stub resolver: recognises show_plan, declines everything else.
                resolveCard: async (block) =>
                    block.type === "tool_use" && block.name === "show_plan" ? ({ type: "data-plan", id: "pres-x", planId: "pln-abc12345" } as never) : null,
            },
        );

        expect(cortex[0]!.parts).toEqual([
            { type: "text", text: "Here's the plan." },
            // show_plan → reconstructed card (not a generic tool-call chip)
            { type: "data-plan", id: "pres-x", planId: "pln-abc12345" },
            // unrecognised tool → generic chip fallback; no paired result, so `ok`
            { type: "tool-call", toolCallId: "call-10", toolName: "run_pca", status: "finished", outcome: "ok" },
        ]);
    });

    it("reconstructs a plan-mode execute_analysis tool-call into a data-run-card", async () => {
        const analysisId = "analysis-runcard-1";
        const now = new Date().toISOString();
        await pool.query({
            text: `INSERT INTO cortex_analysis_state
             (analysis_id, status, context, data_profile_status, created_at, updated_at)
             VALUES ($1, 'active', NULL, 'completed', $2, $2)`,
            values: [analysisId, now],
        });
        const planId = (
            await insertPlan(pool, {
                analysisId,
                plan: {
                    analytical_narrative: "Differential expression workflow",
                    steps: [
                        {
                            id: "T1S1",
                            name: "QC",
                            track: "qc",
                            step_type: "analysis",
                            question: "Run QC",
                            acceptance_criteria: ["qc done"],
                            depends_on: [],
                            maxSteps: 10,
                        },
                        {
                            id: "T1S2",
                            name: "DE",
                            track: "de",
                            step_type: "analysis",
                            question: "Run DE",
                            acceptance_criteria: ["de done"],
                            depends_on: ["T1S1"],
                            maxSteps: 10,
                        },
                    ],
                    created_at: now,
                    omicsType: "transcriptomics",
                },
            })
        )._unsafeUnwrap();
        const runId = "run-card-fixed-1";
        (
            await insertRun(pool, {
                runId,
                analysisId,
                workflowName: "executeAnalysis",
                planId,
            })
        )._unsafeUnwrap();

        const cortex = await contentToCortexMessages(
            [
                stored(0, {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Starting the run." },
                        { type: "tool-call", toolCallId: "call-ep", toolName: "execute_analysis", input: { mode: "plan", planId } },
                    ],
                }),
            ],
            { resolveCard: createCardResolver(pool, analysisId, "/tmp/cortex-test-no-previews") },
        );

        expect(cortex[0]!.parts[0]).toEqual({ type: "text", text: "Starting the run." });
        const card = cortex[0]!.parts[1] as unknown as Record<string, unknown>;
        expect(card).toMatchObject({
            type: "data-run-card",
            runId,
            planId,
            title: "transcriptomics analysis",
            stepCount: 2,
        });
        expect(typeof card.id).toBe("string");
    });

    it("uses the plan's title for the run card when present", async () => {
        const analysisId = "analysis-runcard-title";
        const now = new Date().toISOString();
        await pool.query({
            text: `INSERT INTO cortex_analysis_state
             (analysis_id, status, context, data_profile_status, created_at, updated_at)
             VALUES ($1, 'active', NULL, 'completed', $2, $2)`,
            values: [analysisId, now],
        });
        const planId = (
            await insertPlan(pool, {
                analysisId,
                plan: {
                    title: "AD lesional vs control DE",
                    analytical_narrative: "Differential expression workflow",
                    steps: [
                        {
                            id: "T1S1",
                            name: "DE",
                            track: "de",
                            step_type: "analysis",
                            question: "Run DE",
                            acceptance_criteria: ["de done"],
                            depends_on: [],
                            maxSteps: 10,
                        },
                    ],
                    created_at: now,
                    omicsType: "transcriptomics",
                },
            })
        )._unsafeUnwrap();
        const runId = "run-card-titled-1";
        (
            await insertRun(pool, {
                runId,
                analysisId,
                workflowName: "executeAnalysis",
                planId,
            })
        )._unsafeUnwrap();

        const cortex = await contentToCortexMessages(
            [
                stored(0, {
                    role: "assistant",
                    content: [{ type: "tool-call", toolCallId: "call-ep", toolName: "execute_analysis", input: { mode: "plan", planId } }],
                }),
            ],
            { resolveCard: createCardResolver(pool, analysisId, "/tmp/cortex-test-no-previews") },
        );

        const card = cortex[0]!.parts[0] as unknown as Record<string, unknown>;
        // The plan's own title wins over the `${omicsType} analysis` fallback.
        expect(card).toMatchObject({
            type: "data-run-card",
            runId,
            planId,
            title: "AD lesional vs control DE",
            stepCount: 1,
        });
    });

    it("reconstructs an ad hoc execute_analysis tool-call into its deterministic run card", async () => {
        const analysisId = "analysis-adhoc-runcard";
        const invocationId = "call-adhoc";
        const planId = adHocPlanId(analysisId, invocationId);
        const runId = adHocRunId(analysisId, invocationId);
        const now = new Date().toISOString();
        await pool.query({
            text: `INSERT INTO cortex_analysis_state
             (analysis_id, status, context, data_profile_status, created_at, updated_at)
             VALUES ($1, 'active', NULL, 'completed', $2, $2)`,
            values: [analysisId, now],
        });
        (
            await upsertPlan(pool, {
                planId,
                analysisId,
                plan: {
                    title: "Targeted PCA",
                    analytical_narrative: "Run the requested targeted computation",
                    steps: [
                        {
                            id: "T1S1",
                            name: "PCA",
                            track: "adhoc",
                            step_type: "analysis",
                            question: "Run PCA",
                            acceptance_criteria: ["PCA outputs persisted"],
                            depends_on: [],
                            maxSteps: 10,
                        },
                    ],
                    created_at: now,
                },
            })
        )._unsafeUnwrap();
        (
            await insertRun(pool, {
                runId,
                analysisId,
                workflowName: "executeAnalysis",
                planId,
            })
        )._unsafeUnwrap();

        const cortex = await contentToCortexMessages(
            [
                stored(0, {
                    role: "assistant",
                    content: [
                        {
                            type: "tool-call",
                            toolCallId: invocationId,
                            toolName: "execute_analysis",
                            input: { mode: "adhoc", request: "Run PCA" },
                        },
                    ],
                }),
            ],
            { resolveCard: createCardResolver(pool, analysisId, "/tmp/cortex-test-no-previews") },
        );

        expect(cortex[0]!.parts[0]).toMatchObject({
            type: "data-run-card",
            runId,
            planId,
            title: "Targeted PCA",
            stepCount: 1,
        });
    });

    it("reconstructs a data-report-preview from a migrated iterateReport tool-call", async () => {
        const analysisId = "analysis-preview-reconstruct";
        const previewId = "prv-3860785d";
        const sessions = await mkdtemp(join(tmpdir(), "cortex-preview-rc-"));
        try {
            const workspaceRoot = join(sessions, analysisId);
            const root = join(workspaceRoot, "previews", previewId);
            await mkdir(join(root, "v1"), { recursive: true });
            await writeFile(join(root, "v1", "index.html"), "<html></html>");
            await writeFile(join(root, "preview-meta.json"), JSON.stringify({ title: "Meta Title", format: "html" }));

            const cortex = await contentToCortexMessages(
                [
                    stored(0, {
                        role: "assistant",
                        content: [
                            // Migrated transcripts carry the legacy camelCase tool name and
                            // a creation-mode input with no `previewId`.
                            {
                                type: "tool-call",
                                toolCallId: "toolu_x",
                                toolName: "iterateReport",
                                input: { report: { title: "Tirzepatide Report" } },
                            },
                            { type: "tool-call", toolCallId: "toolu_y", toolName: "legacy_workspace_read_file", input: {} },
                        ],
                    }),
                ],
                { resolveCard: createCardResolver(pool, analysisId, workspaceRoot) },
            );

            expect(cortex[0]!.parts).toEqual([
                {
                    type: "data-report-preview",
                    id: expect.stringMatching(/^prev-[0-9a-f]{16}$/),
                    previewId,
                    version: 1,
                    // Input title wins over the meta file.
                    title: "Tirzepatide Report",
                    previewPath: "v1/index.html",
                    format: "html",
                },
                // Unrecognised tool → generic chip fallback (unchanged behaviour).
                {
                    type: "tool-call",
                    toolCallId: "toolu_y",
                    toolName: "legacy_workspace_read_file",
                    status: "finished",
                    outcome: "ok",
                },
            ]);
        } finally {
            await rm(sessions, { recursive: true, force: true });
        }
    });

    it("falls back to a chip when the preview is absent on disk", async () => {
        const cortex = await contentToCortexMessages(
            [
                stored(0, {
                    role: "assistant",
                    content: [{ type: "tool-call", toolCallId: "toolu_z", toolName: "iterate_report", input: {} }],
                }),
            ],
            { resolveCard: createCardResolver(pool, "analysis-no-preview", "/tmp/cortex-test-no-previews") },
        );

        expect(cortex[0]!.parts).toEqual([
            {
                type: "tool-call",
                toolCallId: "toolu_z",
                toolName: "iterate_report",
                status: "finished",
                outcome: "ok",
            },
        ]);
    });

    it("reconstructs a data-presentation card for a show_user echart with a valid dataPath", async () => {
        const input = { kind: "echart", title: "DE", spec: { series: [{ type: "scatter" }] }, dataPath: "runs/run-abc/step-2/output/de.csv" };
        const cortex = await contentToCortexMessages(
            [stored(0, { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-su", toolName: "show_user", input }] })],
            { resolveCard: createCardResolver(pool, "analysis-x", "/tmp/cortex-test-no-previews") },
        );

        const card = cortex[0]!.parts[0] as unknown as Record<string, unknown>;
        expect(card.type).toBe("data-presentation");
        expect((card.content as Record<string, unknown>).dataPath).toBe(input.dataPath);
    });

    it("drops the presentation card when a reloaded show_user echart carries a traversal dataPath (security)", async () => {
        const cortex = await contentToCortexMessages(
            [
                stored(0, {
                    role: "assistant",
                    content: [
                        { type: "tool-call", toolCallId: "call-su", toolName: "show_user", input: { kind: "echart", spec: {}, dataPath: "../../etc/passwd" } },
                    ],
                }),
            ],
            { resolveCard: createCardResolver(pool, "analysis-x", "/tmp/cortex-test-no-previews") },
        );

        // The live tool rejected this path and emitted nothing; the reload path must not resurrect an
        // unvalidated path, so the card is dropped and a generic tool chip stands in.
        expect(cortex[0]!.parts).toEqual([{ type: "tool-call", toolCallId: "call-su", toolName: "show_user", status: "finished", outcome: "ok" }]);
    });

    it("reconstructs a data-file-reference card from a show_file tool-call", async () => {
        const input = {
            title: "Figures",
            files: [{ path: "runs/run-abc/step-1/figures/volcano.png", caption: "volcano" }, { path: "runs/run-abc/step-1/figures/heatmap.png" }],
        };
        const cortex = await contentToCortexMessages(
            [stored(0, { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-sf", toolName: "show_file", input }] })],
            { resolveCard: createCardResolver(pool, "analysis-x", "/tmp/cortex-test-no-previews") },
        );

        expect(cortex[0]!.parts[0]).toMatchObject({
            type: "data-file-reference",
            id: expect.stringMatching(/^pres-[0-9a-f]{16}$/),
            title: "Figures",
            files: [
                { path: "runs/run-abc/step-1/figures/volcano.png", runId: "run-abc", caption: "volcano" },
                { path: "runs/run-abc/step-1/figures/heatmap.png", runId: "run-abc" },
            ],
        });
    });

    it("drops the file-reference card when a reloaded show_file carries a traversal path (security)", async () => {
        const cortex = await contentToCortexMessages(
            [
                stored(0, {
                    role: "assistant",
                    content: [{ type: "tool-call", toolCallId: "call-sf", toolName: "show_file", input: { files: [{ path: "../../etc/passwd" }] } }],
                }),
            ],
            { resolveCard: createCardResolver(pool, "analysis-x", "/tmp/cortex-test-no-previews") },
        );

        expect(cortex[0]!.parts).toEqual([{ type: "tool-call", toolCallId: "call-sf", toolName: "show_file", status: "finished", outcome: "ok" }]);
    });
});

describe("ThreadHistory.loadPage", () => {
    it("paginates by turns oldest-first with total and hasMore, no token eviction (3.1)", async () => {
        // Six user/assistant pairs = six turns (each user message starts a turn).
        const messages: ModelMessage[] = [];
        for (let i = 0; i < 6; i++) {
            messages.push({ role: "user", content: [{ type: "text", text: `m${i}` }] });
            messages.push({ role: "assistant", content: [{ type: "text", text: `r${i}` }] });
        }
        (await history.appendTurn(THREAD, messages))._unsafeUnwrap();

        const first = (await history.loadPage(THREAD, 0, 5))._unsafeUnwrap();
        expect(first.total).toBe(6); // six turns, not twelve rows
        expect(first.messages).toHaveLength(10); // five turns × two rows each
        expect(first.messages[0]!.seq).toBe(0);
        expect(first.hasMore).toBe(true);

        const last = (await history.loadPage(THREAD, 1, 5))._unsafeUnwrap();
        expect(last.total).toBe(6);
        expect(last.messages).toHaveLength(2); // the remaining sixth turn
        expect(last.messages[0]!.seq).toBe(10);
        expect(last.hasMore).toBe(false);
    });

    it("returns a whole multi-row turn intact regardless of perPage (no row truncation)", async () => {
        // One turn: prompt + five serial tool steps (one assistant row each, with a
        // tool-result row between) + a trailing summary. Row-windowed paging
        // would cut the summary off the page the UI fetches; turn-based paging keeps
        // the whole turn — the regression this change fixes.
        const turn: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
        for (let i = 0; i < 5; i++) {
            turn.push({
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read_file", input: {} }],
            });
            turn.push({
                role: "tool",
                content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read_file", output: { type: "text", value: "ok" } }],
            });
        }
        turn.push({ role: "assistant", content: [{ type: "text", text: "summary" }] });
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        // Even with perPage 1, the single turn loads whole: 1 user + 5 tool-call +
        // 5 tool-result + 1 summary = 12 rows.
        const page = (await history.loadPage(THREAD, 0, 1))._unsafeUnwrap();
        expect(page.total).toBe(1);
        expect(page.hasMore).toBe(false);
        expect(page.messages).toHaveLength(12);
        expect(page.messages[0]!.seq).toBe(0);
        expect(page.messages.at(-1)!.message.content).toEqual([{ type: "text", text: "summary" }]);
    });

    it("orders by seq numerically, not lexicographically, across the 10-boundary", async () => {
        const messages: ModelMessage[] = [];
        for (let i = 0; i < 24; i++) {
            messages.push({ role: "user", content: [{ type: "text", text: `m${i}` }] });
        }
        (await history.appendTurn(THREAD, messages))._unsafeUnwrap();

        // One page covering all 24 — a lexicographic sort on the bigint `seq`
        // would yield 0,1,10,11,...,2,20,...,3,... and place seq 9 last.
        const page = (await history.loadPage(THREAD, 0, 40))._unsafeUnwrap();
        const seqs = page.messages.map((m) => m.seq);
        expect(seqs).toEqual(Array.from({ length: 24 }, (_, i) => i));
    });
});

// ── Reloaded outcome and detail (tool-call-detail) ──────────────────

/** A `read_file` stand-in whose hook names the path — the reload resolver's subject. */
const reloadReadFile = defineTool({
    id: "read_file",
    description: "Read a workspace file.",
    inputSchema: z.object({ path: z.string() }),
    describeCall: ({ path }) => path,
    execute: async () => ok({}),
});

/** One assistant row holding a `read_file` call, paired with the supplied result output. */
function callWithResult(output: { type: string; value?: unknown; reason?: string }): StoredMessage[] {
    return [
        stored(0, {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "call-r", toolName: "read_file", input: { path: "output/summary.md" } }],
        }),
        stored(1, {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "call-r", toolName: "read_file", output: output as never }],
        }),
    ];
}

describe("contentToCortexMessages — reloaded outcome", () => {
    it("reports a failed call as an error rather than a success", async () => {
        const cortex = await contentToCortexMessages(callWithResult({ type: "error-text", value: '{"error":"boom","retryable":true}' }));

        expect(cortex[0]!.parts[0]).toMatchObject({ type: "tool-call", toolCallId: "call-r", outcome: "error" });
    });

    it("reports a denied call as denied, distinct from an error", async () => {
        const cortex = await contentToCortexMessages(callWithResult({ type: "execution-denied", reason: "The user rejected this action." }));

        expect(cortex[0]!.parts[0]).toMatchObject({ type: "tool-call", toolCallId: "call-r", outcome: "denied" });
    });

    it("reports a successful call as ok", async () => {
        const cortex = await contentToCortexMessages(callWithResult({ type: "json", value: { status: "ok" } }));

        expect(cortex[0]!.parts[0]).toMatchObject({ type: "tool-call", toolCallId: "call-r", outcome: "ok" });
    });

    it("reports ok for a call whose tool row was never appended", async () => {
        const cortex = await contentToCortexMessages([
            stored(0, {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "call-orphan", toolName: "read_file", input: { path: "a.csv" } }],
            }),
        ]);

        expect(cortex[0]!.parts[0]).toMatchObject({ type: "tool-call", toolCallId: "call-orphan", outcome: "ok" });
    });

    it("pairs each call with its own result across a multi-call turn", async () => {
        const cortex = await contentToCortexMessages([
            stored(0, {
                role: "assistant",
                content: [
                    { type: "tool-call", toolCallId: "call-a", toolName: "read_file", input: { path: "a.csv" } },
                    { type: "tool-call", toolCallId: "call-b", toolName: "read_file", input: { path: "b.csv" } },
                ],
            }),
            stored(1, {
                role: "tool",
                content: [
                    { type: "tool-result", toolCallId: "call-a", toolName: "read_file", output: { type: "json", value: {} } },
                    { type: "tool-result", toolCallId: "call-b", toolName: "read_file", output: { type: "error-text", value: "missing" } },
                ],
            }),
        ]);

        expect(cortex[0]!.parts).toMatchObject([
            { toolCallId: "call-a", outcome: "ok" },
            { toolCallId: "call-b", outcome: "error" },
        ]);
    });
});

describe("contentToCortexMessages — reloaded detail", () => {
    it("rebuilds the detail through a supplied resolver", async () => {
        const cortex = await contentToCortexMessages(callWithResult({ type: "json", value: {} }), {
            resolveDetail: createDetailResolver([reloadReadFile]),
        });

        expect(cortex[0]!.parts[0]).toMatchObject({ type: "tool-call", detail: "output/summary.md", outcome: "ok" });
    });

    it("omits detail entirely when no resolver is supplied, changing nothing else", async () => {
        const rows = callWithResult({ type: "json", value: {} });

        const without = await contentToCortexMessages(rows);
        const with_ = await contentToCortexMessages(rows, { resolveDetail: createDetailResolver([reloadReadFile]) });

        expect("detail" in (without[0]!.parts[0] as object)).toBe(false);
        // The detail is the only difference between the two conversions.
        const { detail, ...rest } = with_[0]!.parts[0] as unknown as Record<string, unknown>;
        expect(detail).toBe("output/summary.md");
        expect(without[0]!.parts[0]).toEqual(rest as never);
    });

    it("omits detail for a tool the supplied list does not describe", async () => {
        const cortex = await contentToCortexMessages(callWithResult({ type: "json", value: {} }), {
            resolveDetail: createDetailResolver([]),
        });

        expect("detail" in (cortex[0]!.parts[0] as object)).toBe(false);
    });

    it("stores no detail — the persisted row is the model transcript only", async () => {
        const turn: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "read it" }] },
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-s", toolName: "read_file", input: { path: "output/summary.md" } }] },
        ];
        (await history.appendTurn(THREAD, turn))._unsafeUnwrap();

        const { rows } = await pool.query<{ message_envelope: unknown }>("SELECT message_envelope FROM messages WHERE thread_id = $1", [THREAD]);

        expect(rows).toHaveLength(2);
        expect(JSON.stringify(rows)).not.toContain("detail");
    });
});
