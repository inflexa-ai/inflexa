import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { insertPlan } from "../state/plans.js";
import { insertRun } from "../state/runs.js";
import { envelopeMessage } from "./ai-sdk-message-storage.js";
import { contentToCortexMessages } from "./content-to-cortex.js";
import { createCardResolver } from "./reconstruct-cards.js";
import { createThreadHistory, type StoredMessage, type ThreadHistory } from "./thread-history.js";

const THREAD = "thread-convert-1";

let pool: Pool;
let drop: () => Promise<void>;
let history: ThreadHistory;

function stored(seq: number, message: ModelMessage): StoredMessage {
    return { seq, envelope: envelopeMessage(message), message };
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
            { type: "tool-call", toolCallId: "call-1", toolName: "run_pca", status: "finished" },
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
            { type: "tool-call", toolCallId: "call-0", toolName: "read_file", status: "finished" },
            { type: "tool-call", toolCallId: "call-1", toolName: "read_file", status: "finished" },
            { type: "tool-call", toolCallId: "call-2", toolName: "read_file", status: "finished" },
            { type: "tool-call", toolCallId: "call-3", toolName: "read_file", status: "finished" },
            { type: "tool-call", toolCallId: "call-4", toolName: "read_file", status: "finished" },
            { type: "text", text: "Here is the report." },
        ]);
    });

    it("converts a bare-string content row to a single text part", async () => {
        const cortex = await contentToCortexMessages([stored(0, { role: "user", content: "hello" })]);
        expect(cortex).toEqual([{ id: "0", role: "user", parts: [{ type: "text", text: "hello" }] }]);
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
            // Stub resolver: recognises show_plan, declines everything else.
            async (block) =>
                block.type === "tool_use" && block.name === "show_plan" ? ({ type: "data-plan", id: "pres-x", planId: "pln-abc12345" } as never) : null,
        );

        expect(cortex[0]!.parts).toEqual([
            { type: "text", text: "Here's the plan." },
            // show_plan → reconstructed card (not a generic tool-call chip)
            { type: "data-plan", id: "pres-x", planId: "pln-abc12345" },
            // unrecognised tool → generic chip fallback
            { type: "tool-call", toolCallId: "call-10", toolName: "run_pca", status: "finished" },
        ]);
    });

    it("reconstructs an execute_plan tool-call into a data-run-card", async () => {
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
                        { type: "tool-call", toolCallId: "call-ep", toolName: "execute_plan", input: { planId } },
                    ],
                }),
            ],
            createCardResolver(pool, analysisId, "/tmp/cortex-test-no-previews"),
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
                    content: [{ type: "tool-call", toolCallId: "call-ep", toolName: "execute_plan", input: { planId } }],
                }),
            ],
            createCardResolver(pool, analysisId, "/tmp/cortex-test-no-previews"),
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

    it("reconstructs a data-preview from a migrated iterateReport tool-call", async () => {
        const analysisId = "analysis-preview-reconstruct";
        const previewId = "prv-3860785d";
        const sessions = await mkdtemp(join(tmpdir(), "cortex-preview-rc-"));
        try {
            const root = join(sessions, "previews", analysisId, previewId);
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
                createCardResolver(pool, analysisId, sessions),
            );

            expect(cortex[0]!.parts).toEqual([
                {
                    type: "data-preview",
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
            createCardResolver(pool, "analysis-no-preview", "/tmp/cortex-test-no-previews"),
        );

        expect(cortex[0]!.parts).toEqual([
            {
                type: "tool-call",
                toolCallId: "toolu_z",
                toolName: "iterate_report",
                status: "finished",
            },
        ]);
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
