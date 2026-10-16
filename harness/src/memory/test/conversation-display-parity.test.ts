import { describe, expect, it } from "bun:test";

import type { ModelMessage } from "ai";

import { applyChatFrame, toChatFrame } from "../../contracts/chat-frame.js";
import type { ChatMessage, MessagePart } from "../../contracts/message.js";
import { createSubAgentActivityTracker } from "../../contracts/subagent-activity.js";
import type { TokenUsageRollup } from "../../contracts/usage.js";
import type { EmitFn } from "../../loop/types.js";
import { envelopeMessage, markCompactionExchange, summaryMarkerMessage, syntheticUserMessage } from "../ai-sdk-message-storage.js";
import { storedMessagesToChat } from "../conversation-display-replay.js";
import { createConversationDisplayRecorder } from "../conversation-display-recorder.js";
import { envelopeDisplayMessages, parseStoredDisplayEnvelope, type ConversationUIMessage } from "../conversation-display-storage.js";
import type { StoredMessage, StoredTurnRecord } from "../thread-history.js";
import { jsonClone } from "../../lib/json.js";

type TurnEvent = Parameters<EmitFn>[0];

/** One model call of the loop: the events that it emits, and the messages that the round sink gets. */
type Round = {
    readonly events: readonly TurnEvent[];
    readonly model: readonly ModelMessage[];
};

/** The facts that only a stored row holds. */
type RowFacts = {
    readonly turn?: StoredTurnRecord;
    readonly author?: string;
    readonly createdAt?: Date;
};

const ROOT = { agentId: "conversation-agent", callPath: ["conversation-agent"] };
const SUB = { agentId: "literature-reviewer", callPath: ["conversation-agent", "literature-reviewer"], invocationId: "t2" };
const USER_TEXT = "Compare the two groups.";
const USER_ID = "user-1";
const ASSISTANT_ID = "assistant-1";
const USAGE: TokenUsageRollup = { inputTokens: 1200, outputTokens: 340 };
const ASK = { id: "ask-1", title: "Run the plan?", command: "inflexa run pln-0a1b2c3d" };

const CLOCK_START = Date.parse("2026-10-12T10:00:00.000Z");

/** A clock that gives one second more at each call. Each path gets its own, and each path reads it once for each frame. */
function stepClock(): () => number {
    let calls = 0;
    return () => CLOCK_START + 1000 * calls++;
}

/** A round whose model reply holds the text that the round streamed, as a streaming provider gives it. */
function round(events: readonly TurnEvent[]): Round {
    const text = events.map((event) => (event.type === "text-delta" ? event.text : "")).join("");
    return { events, model: [{ role: "assistant", content: text }] };
}

/** The live path: each event through `toChatFrame`, the sub-agent tracker, and `applyChatFrame`, then the `finish` of the host. */
function live(rounds: readonly Round[], turnUsage?: TokenUsageRollup): ChatMessage[] {
    let messages: ChatMessage[] = [{ id: USER_ID, role: "user", parts: [{ type: "text", text: USER_TEXT }] }];
    const tracker = createSubAgentActivityTracker();
    const now = stepClock();
    for (const event of rounds.flatMap((r) => r.events)) {
        const frame = toChatFrame(event, ROOT);
        if (frame === null) continue;
        messages = applyChatFrame(messages, frame, ASSISTANT_ID).messages;
        const activity = tracker.track(frame, now());
        if (activity !== null) messages = applyChatFrame(messages, activity, ASSISTANT_ID).messages;
    }
    return applyChatFrame(messages, { type: "finish", source: ROOT, turnUsage: !(turnUsage === undefined) ? turnUsage : undefined }, ASSISTANT_ID).messages;
}

/** The reload path: the recorder takes each round as `runChatTurn` does, each group goes through the stored shape, and the replay reads the rows. */
async function replay(rounds: readonly Round[], facts: RowFacts = {}): Promise<ChatMessage[]> {
    const recorder = createConversationDisplayRecorder({
        userText: USER_TEXT,
        agentId: ROOT.agentId,
        sink: () => {},
        userMessageId: USER_ID,
        assistantMessageId: ASSISTANT_ID,
        now: stepClock(),
    });
    const user: ModelMessage = { role: "user", content: USER_TEXT };
    const groups: { model: readonly ModelMessage[]; display: ConversationUIMessage[] }[] = [{ model: [user], display: recorder.takeOpening() }];
    for (const r of rounds) {
        for (const event of r.events) await recorder.emit(event);
        groups.push({ model: r.model, display: recorder.takeRound(r.model) });
    }

    const rows: StoredMessage[] = [];
    for (const group of groups) {
        const displayEnvelope =
            group.display.length === 0
                ? undefined
                : await parseStoredDisplayEnvelope(jsonClone(envelopeDisplayMessages(group.display)), `parity/${rows.length}/display`);
        for (const [index, message] of group.model.entries()) {
            const opening = rows.length === 0;
            rows.push({
                seq: rows.length,
                envelope: envelopeMessage(message),
                message,
                displayEnvelope: index === 0 && displayEnvelope !== undefined ? displayEnvelope : undefined,
                turn: opening && facts.turn !== undefined ? facts.turn : undefined,
                author: opening && facts.author !== undefined ? facts.author : undefined,
                createdAt: !(facts.createdAt === undefined) ? facts.createdAt : undefined,
            });
        }
    }
    return storedMessagesToChat(rows);
}

describe("the live path and the replay of one turn", () => {
    const rounds: Round[] = [
        round([
            { type: "text-delta", text: "I read the counts " },
            { type: "text-delta", text: "and ask the reviewer." },
            { type: "iteration", source: ROOT, index: 0, final: false },
            { type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {}, detail: "data/counts.csv" },
            { type: "tool-started", source: ROOT, toolUseId: "t2", name: "literature_review", input: {}, detail: "TP53 in colorectal cancer" },
            { type: "iteration", source: SUB, index: 0, final: false },
            { type: "tool-started", source: SUB, toolUseId: "s1", name: "search_pubmed", input: {}, detail: "TP53" },
            { type: "tool-finished", source: SUB, toolUseId: "s1", name: "search_pubmed", outcome: "ok", detail: "TP53", durationMs: 800 },
            { type: "data-presentation", source: SUB, data: { id: "sub-card", content: { kind: "markdown", body: "A note of the reviewer" } } },
            { type: "tool-finished", source: ROOT, toolUseId: "t1", name: "read_file", outcome: "ok", detail: "data/counts.csv", durationMs: 12 },
            {
                type: "tool-finished",
                source: ROOT,
                toolUseId: "t2",
                name: "literature_review",
                outcome: "ok",
                detail: "TP53 in colorectal cancer",
                durationMs: 4200,
            },
        ]),
        round([
            { type: "text-delta", text: "Here is the plan." },
            { type: "iteration", source: ROOT, index: 1, final: false },
            { type: "tool-started", source: ROOT, toolUseId: "t3", name: "show_plan", input: {} },
            { type: "tool-started", source: ROOT, toolUseId: "t4", name: "grep", input: {}, detail: "TP53" },
            { type: "data-plan", source: ROOT, data: { id: "plan-card", planId: "pln-0a1b2c3d", title: "Differential expression" } },
            { type: "tool-finished", source: ROOT, toolUseId: "t3", name: "show_plan", outcome: "ok" },
            { type: "tool-finished", source: ROOT, toolUseId: "t4", name: "grep", outcome: "error", detail: "TP53", durationMs: 3 },
        ]),
        round([
            { type: "iteration", source: ROOT, index: 2, final: false },
            { type: "tool-started", source: ROOT, toolUseId: "t5", name: "execute_plan", input: {}, detail: "pln-0a1b2c3d" },
            { type: "data-ask", data: { ...ASK, status: "pending" } },
            { type: "data-ask", data: { ...ASK, status: "resolved" } },
            {
                type: "data-run-card",
                source: ROOT,
                data: { id: "run-card", runId: "run-1", planId: "pln-0a1b2c3d", title: "Differential expression", stepCount: 3 },
            },
            { type: "tool-finished", source: ROOT, toolUseId: "t5", name: "execute_plan", outcome: "ok", detail: "pln-0a1b2c3d", durationMs: 95 },
        ]),
        round([
            { type: "text-delta", text: "The run started. " },
            { type: "text-delta", text: "I report the result when it ends." },
            { type: "iteration", source: ROOT, index: 3, final: true },
        ]),
    ];

    it("gives the same messages", async () => {
        const shown = live(rounds, USAGE);

        expect(shown[1].parts).toEqual([
            { type: "text", text: "I read the counts and ask the reviewer." },
            { type: "tool-call", toolCallId: "t1", toolName: "read_file", outcome: "ok", detail: "data/counts.csv", durationMs: 12 },
            { type: "tool-call", toolCallId: "t2", toolName: "literature_review", outcome: "ok", detail: "TP53 in colorectal cancer", durationMs: 4200 },
            {
                type: "data-subagent-activity",
                id: "subagent-activity-t2",
                toolCallId: "t2",
                // The clock reads once for each frame: the fifth read of the turn is the start of the call `s1`.
                entries: [
                    {
                        agentId: "literature-reviewer",
                        callPath: ["conversation-agent", "literature-reviewer"],
                        tool: "search_pubmed",
                        label: "TP53",
                        startedAt: new Date(CLOCK_START + 5000).toISOString(),
                        endedAt: new Date(CLOCK_START + 5800).toISOString(),
                        outcome: "ok",
                    },
                ],
                dropped: 0,
            },
            { type: "text", text: "Here is the plan." },
            { type: "tool-call", toolCallId: "t3", toolName: "show_plan", outcome: "ok" },
            { type: "tool-call", toolCallId: "t4", toolName: "grep", outcome: "error", detail: "TP53", durationMs: 3 },
            { type: "data-plan", id: "plan-card", planId: "pln-0a1b2c3d", title: "Differential expression" },
            { type: "tool-call", toolCallId: "t5", toolName: "execute_plan", outcome: "ok", detail: "pln-0a1b2c3d", durationMs: 95 },
            { type: "data-ask", ...ASK, status: "resolved" },
            { type: "data-run-card", id: "run-card", runId: "run-1", planId: "pln-0a1b2c3d", title: "Differential expression", stepCount: 3 },
            { type: "text", text: "The run started. I report the result when it ends." },
        ]);
        expect(shown[1].usage).toEqual(USAGE);
        expect(await replay(rounds, { turn: { status: "done", usage: USAGE } })).toEqual(shown);
    });
});

// Each test below pins one difference that the two paths have today. A change that removes a difference changes its test.
describe("the known differences between the live path and the replay", () => {
    it("a call that never finished: the replay gives incomplete, and the live message gives no outcome", async () => {
        const rounds = [round([{ type: "tool-started", source: ROOT, toolUseId: "t1", name: "read_file", input: {}, detail: "data/counts.csv" }])];
        const call = { type: "tool-call", toolCallId: "t1", toolName: "read_file", detail: "data/counts.csv" } satisfies MessagePart;

        expect(live(rounds)[1].parts).toEqual([call]);
        expect((await replay(rounds))[1].parts).toEqual([{ ...call, outcome: "incomplete" }]);
    });

    it("a sub-agent call that never finished: the replay gives incomplete, and the live entry gives no outcome", async () => {
        const rounds = [
            round([
                { type: "tool-started", source: ROOT, toolUseId: "t1", name: "plan", input: {} },
                { type: "tool-started", source: { ...SUB, invocationId: "t1" }, toolUseId: "s1", name: "search_pubmed", input: {}, detail: "TP53" },
            ]),
        ];
        const entry = {
            agentId: "literature-reviewer",
            callPath: ["conversation-agent", "literature-reviewer"],
            tool: "search_pubmed",
            label: "TP53",
            startedAt: new Date(CLOCK_START + 1000).toISOString(),
        };
        const activity = (entries: unknown[]) => ({
            type: "data-subagent-activity" as const,
            id: "subagent-activity-t1",
            toolCallId: "t1",
            entries,
            dropped: 0,
        });
        const part = (messages: ChatMessage[]): unknown[] => messages[1].parts.filter((p) => p.type === "data-subagent-activity");

        expect(part(live(rounds))).toEqual([activity([entry])]);
        expect(part(await replay(rounds))).toEqual([activity([{ ...entry, outcome: "incomplete" }])]);
    });

    it("an ask that is pending at the end of the turn: the replay gives aborted, and the live message keeps pending", async () => {
        const rounds = [round([{ type: "data-ask", data: { ...ASK, status: "pending" } }])];

        expect(live(rounds)[1].parts).toEqual([{ type: "data-ask", ...ASK, status: "pending" }]);
        expect((await replay(rounds))[1].parts).toEqual([{ type: "data-ask", ...ASK, status: "aborted" }]);
    });

    it("a compaction: the replay gives a divider between two assistant messages, and the live message holds the part", async () => {
        const figures = { tokensBefore: 162_000, durationMs: 21_000 };
        // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
        const exchange = [syntheticUserMessage("Reply with the summary."), { role: "assistant", content: "The user compares two groups." } as ModelMessage].map(
            (message) => markCompactionExchange(message, "c-1"),
        );
        const rounds: Round[] = [
            round([{ type: "text-delta", text: "before" }]),
            {
                events: [{ type: "data-compaction", source: ROOT, data: { id: "c-1", status: "running", tokensBefore: figures.tokensBefore } }],
                model: exchange,
            },
            { events: [], model: [summaryMarkerMessage("The user compares two groups.", { kind: "summary", id: "c-1", ...figures })] },
            round([
                { type: "data-compaction", source: ROOT, data: { id: "c-1", status: "done", ...figures } },
                { type: "text-delta", text: "after" },
            ]),
        ];
        const compaction = { type: "data-compaction", id: "c-1", status: "done", ...figures } satisfies MessagePart;

        expect(live(rounds)[1].parts).toEqual([{ type: "text", text: "before" }, compaction, { type: "text", text: "after" }]);
        const replayed = await replay(rounds);
        expect(replayed.map((message) => message.role)).toEqual(["user", "assistant", "system", "assistant"]);
        expect(replayed.slice(1).map((message) => message.parts)).toEqual([
            [{ type: "text", text: "before" }],
            [compaction],
            [{ type: "text", text: "after" }],
        ]);
    });

    it("a round that streamed no text: the replay takes the text of the model reply, and the live path shows none", async () => {
        const rounds: Round[] = [{ events: [], model: [{ role: "assistant", content: "The whole answer." }] }];

        expect(live(rounds)).toEqual([{ id: USER_ID, role: "user", parts: [{ type: "text", text: USER_TEXT }] }]);
        expect((await replay(rounds))[1].parts).toEqual([{ type: "text", text: "The whole answer." }]);
    });

    it("the text of two rounds with no part between them: the replay keeps two text parts, and the live message joins them", async () => {
        // A reply that the output limit cut, with no tool call, continues in a new round.
        const rounds = [round([{ type: "text-delta", text: "First half, " }]), round([{ type: "text-delta", text: "second half." }])];

        expect(live(rounds)[1].parts).toEqual([{ type: "text", text: "First half, second half." }]);
        expect((await replay(rounds))[1].parts).toEqual([
            { type: "text", text: "First half, " },
            { type: "text", text: "second half." },
        ]);
    });

    it("the facts of the stored rows: the replay adds the turn duration, the interruption, the author, and the creation time", async () => {
        const rounds = [round([{ type: "text-delta", text: "partial" }])];
        const createdAt = new Date("2026-09-28T10:00:00.000Z");
        const [user, reply] = live(rounds, USAGE);

        expect(await replay(rounds, { turn: { status: "aborted", usage: USAGE, durationMs: 4321 }, author: "dr.chen@lab.example", createdAt })).toEqual([
            { ...user, author: "dr.chen@lab.example", createdAt: createdAt.toISOString() },
            { ...reply, durationMs: 4321, interrupted: true, createdAt: createdAt.toISOString() },
        ]);
    });
});
