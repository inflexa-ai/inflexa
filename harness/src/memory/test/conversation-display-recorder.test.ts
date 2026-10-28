import { describe, expect, it } from "bun:test";

import type { ModelMessage } from "ai";

import type { EmitFn } from "../../loop/types.js";
import { dropMarkerMessage, markCompactionExchange, summaryMarkerMessage, syntheticUserMessage } from "../ai-sdk-message-storage.js";
import { createConversationDisplayRecorder } from "../conversation-display-recorder.js";
import type { ConversationUIMessage } from "../conversation-display-storage.js";
import { presentAt } from "../../lib/present.js";

const TOP = { agentId: "conversation", callPath: ["conversation"] };
const SUB = { agentId: "child", callPath: ["conversation", "child"] };

type TurnEvent = Parameters<EmitFn>[0];

function harness() {
    const forwarded: TurnEvent[] = [];
    const recorder = createConversationDisplayRecorder({
        userText: "question",
        agentId: TOP.agentId,
        sink: (event) => {
            forwarded.push(event);
        },
    });
    /** The ids of the `message-start` events of one role that the sink got, in the order of the stream. */
    const announced = (role: "user" | "assistant"): string[] =>
        forwarded.flatMap((event) => (event.type === "message-start" && event.role === role ? [event.messageId] : []));
    return { recorder, forwarded, announced };
}

describe("conversation display recorder", () => {
    it("preserves text/card/text order and copies emitted data", async () => {
        const { recorder, forwarded } = harness();
        const data = { id: "p1", content: { kind: "markdown" as const, body: "card" } };
        await recorder.emit({ type: "text-delta", text: "before" });
        await recorder.emit({ type: "data-presentation", source: TOP, data });
        data.content.body = "mutated";
        await recorder.emit({ type: "text-delta", text: "after" });

        const display = recorder.finish();
        expect(presentAt(display, 1).parts).toEqual([
            { type: "text", text: "before", state: "done" },
            { type: "data-presentation", id: "p1", data: { id: "p1", content: { kind: "markdown", body: "card" } } },
            { type: "text", text: "after", state: "done" },
        ]);
        expect(forwarded.map((event) => event.type)).toEqual(["message-start", "message-start", "text-delta", "data-presentation", "text-delta"]);
    });

    it("keeps each plan step field that the card shows", async () => {
        const { recorder } = harness();
        const step = {
            id: "T1S1",
            name: "Normalize",
            agent: "rna-seq",
            question: "Which genes change?",
            depends_on: [],
            maxSteps: 40,
            track: "1",
            step_type: "analysis",
            acceptance_criteria: ["A counts table exists"],
            constraints: ["Use DESeq2"],
            caveats: ["Low depth"],
            resources: { cpu: 4, memoryGb: 16, gpu: { count: 1 } },
        };
        await recorder.emit({ type: "data-plan", source: TOP, data: { id: "pres-1", planId: "pln-0123abcd", steps: [step] } });

        const display = recorder.finish();
        expect(presentAt(display, 1).parts).toEqual([{ type: "data-plan", id: "pres-1", data: { id: "pres-1", planId: "pln-0123abcd", steps: [step] } }]);
    });

    it("keeps observed concurrent card order rather than tool declaration order", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "a", name: "tool_a", input: {} });
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "b", name: "tool_b", input: {} });
        await recorder.emit({
            type: "data-presentation",
            source: TOP,
            data: { id: "from-b", content: { kind: "markdown", body: "B" } },
        });
        await recorder.emit({
            type: "data-presentation",
            source: TOP,
            data: { id: "from-a", content: { kind: "markdown", body: "A" } },
        });
        // Finishing out of start order must not reorder the parts: each call reconciles
        // in the position it first took, which is the order the user watched them appear.
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "b", name: "tool_b", outcome: "ok" });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "a", name: "tool_a", outcome: "ok" });

        expect(presentAt(recorder.finish(), 1).parts.map((part) => ("id" in part ? part.id : part.type))).toEqual(["a", "b", "from-b", "from-a"]);
    });

    it("records a child-session-started part in the position of its emission", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "text-delta", text: "starting" });
        await recorder.emit({ type: "data-child-session-started", source: TOP, data: { threadId: "r1", parentThreadId: "p1", threadType: "report" } });
        await recorder.emit({ type: "text-delta", text: "done" });

        // The part is durable conversation display, thus the recorder keeps it
        // between the two text runs and a reload shows it where the spawn ran.
        const display = recorder.finish();
        expect(presentAt(display, 1).parts).toEqual([
            { type: "text", text: "starting", state: "done" },
            { type: "data-child-session-started", data: { threadId: "r1", parentThreadId: "p1", threadType: "report" } },
            { type: "text", text: "done", state: "done" },
        ]);
    });

    it("records a report-rendered part in the position of its emission", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "text-delta", text: "rendering" });
        await recorder.emit({
            type: "data-report-rendered",
            source: TOP,
            data: { id: "rr1", renderedAt: "2026-08-18T00:00:00.000Z", title: "Report" },
        });
        await recorder.emit({ type: "text-delta", text: "done" });

        // The part is durable conversation display, thus the recorder keeps it
        // between the two text runs and a reload shows it where the render ran.
        const display = recorder.finish();
        expect(presentAt(display, 1).parts).toEqual([
            { type: "text", text: "rendering", state: "done" },
            { type: "data-report-rendered", id: "rr1", data: { id: "rr1", renderedAt: "2026-08-18T00:00:00.000Z", title: "Report" } },
            { type: "text", text: "done", state: "done" },
        ]);
    });

    it("keeps an emitted compaction part out of the assistant message, and forwards it", async () => {
        const { recorder, forwarded, announced } = harness();
        await recorder.emit({ type: "text-delta", text: "before" });
        await recorder.emit({ type: "data-compaction", source: TOP, data: { id: "c-1", status: "running", tokensBefore: 162_000 } });
        await recorder.emit({
            type: "data-compaction",
            source: TOP,
            data: { id: "c-1", status: "done", tokensBefore: 162_000, durationMs: 21_000 },
        });

        expect(recorder.takeRound([])).toEqual([
            { id: announced("assistant")[0] ?? "", role: "assistant", parts: [{ type: "text", text: "before", state: "done" }] },
        ]);
        expect(forwarded.filter((event) => event.type === "data-compaction")).toHaveLength(2);
    });

    it("records each call's outcome and detail as shown, denial distinct from failure", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "r", name: "read_file", input: {}, detail: "scripts/run.py" });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "r", name: "read_file", outcome: "ok", detail: "scripts/run.py" });
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "x", name: "execute_command", input: {} });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "x", name: "execute_command", outcome: "denied" });
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "e", name: "grep", input: {} });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "e", name: "grep", outcome: "error" });

        expect(presentAt(recorder.finish(), 1).parts).toEqual([
            { type: "data-tool-call", id: "r", data: { toolCallId: "r", toolName: "read_file", outcome: "ok", detail: "scripts/run.py" } },
            { type: "data-tool-call", id: "x", data: { toolCallId: "x", toolName: "execute_command", outcome: "denied" } },
            { type: "data-tool-call", id: "e", data: { toolCallId: "e", toolName: "grep", outcome: "error" } },
        ]);
    });

    it("reconciles approval to one terminal part and excludes sub-agent display", async () => {
        const { recorder } = harness();
        const base = { id: "ask-1", title: "Run?", command: "python analysis.py" };
        await recorder.emit({ type: "data-ask", source: TOP, data: { ...base, status: "pending" } });
        await recorder.emit({
            type: "data-presentation",
            source: SUB,
            data: { id: "hidden", content: { kind: "markdown", body: "child" } },
        });
        await recorder.emit({ type: "data-ask", source: TOP, data: { ...base, status: "resolved" } });

        expect(presentAt(recorder.finish(), 1).parts).toEqual([{ type: "data-ask", id: "ask-1", data: { ...base, status: "resolved" } }]);
    });

    it("leaves an unfinished call incomplete on interruption", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "call-1", name: "execute_analysis", input: { mode: "plan" } });
        await recorder.emit({
            type: "data-ask",
            source: TOP,
            data: { id: "ask-interrupted", title: "Run?", command: "inflexa run", status: "pending" },
        });

        const assistant = recorder.finish({ interrupted: true })[1];
        if (assistant === undefined) throw new Error("assistant is absent");
        expect(assistant.metadata).toEqual({ interrupted: true });
        // The call never finished, so it still holds the `incomplete` it was recorded with
        // at dispatch. An interrupted call is neither a success nor a failure, and one field
        // carrying `incomplete` says so without a reader having to combine two.
        expect(assistant.parts[0]).toEqual({
            type: "data-tool-call",
            id: "call-1",
            data: { toolCallId: "call-1", toolName: "execute_analysis", outcome: "incomplete" },
        });
        expect(assistant.parts[1]).toEqual({
            type: "data-ask",
            id: "ask-interrupted",
            data: { id: "ask-interrupted", title: "Run?", command: "inflexa run", status: "aborted" },
        });
    });

    it("uses final text only when the provider emitted no deltas", async () => {
        const { recorder } = harness();
        expect(presentAt(recorder.finish({ fallbackText: "whole answer" }), 1).parts).toEqual([{ type: "text", text: "whole answer", state: "done" }]);

        const streamed = harness().recorder;
        await streamed.emit({ type: "text-delta", text: "streamed" });
        expect(presentAt(streamed.finish({ fallbackText: "streamed in full" }), 1).parts).toEqual([{ type: "text", text: "streamed", state: "done" }]);
    });
});

describe("conversation display recorder — sub-agent activity", () => {
    const PLANNER = { agentId: "planner", callPath: ["conversation", "planner"], invocationId: "t1" };
    const T0 = Date.parse("2026-10-12T10:00:00.000Z");

    function timed() {
        let tick = 0;
        const recorder = createConversationDisplayRecorder({
            userText: "question",
            agentId: TOP.agentId,
            sink: () => {},
            now: () => T0 + 1000 * tick++,
        });
        return recorder;
    }

    it("keeps the tool calls of a sub-agent as entries of the part of their root call", async () => {
        const recorder = timed();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "generate_plan", input: {} });
        await recorder.emit({ type: "iteration", source: PLANNER, index: 0, final: false });
        await recorder.emit({ type: "tool-started", source: PLANNER, toolUseId: "s1", name: "search_pubmed", input: { secret: "key" }, detail: "TP53" });
        await recorder.emit({ type: "tool-finished", source: PLANNER, toolUseId: "s1", name: "search_pubmed", outcome: "ok", durationMs: 250 });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "t1", name: "generate_plan", outcome: "ok" });

        const parts = presentAt(recorder.finish(), 1).parts;
        const stored = parts.find((part) => part.type === "data-subagent-activity");
        expect(stored).toEqual({
            type: "data-subagent-activity",
            id: "subagent-activity-t1",
            data: {
                id: "subagent-activity-t1",
                toolCallId: "t1",
                dropped: 0,
                entries: [
                    {
                        agentId: "planner",
                        callPath: ["conversation", "planner"],
                        tool: "search_pubmed",
                        label: "TP53",
                        startedAt: new Date(T0 + 2000).toISOString(),
                        endedAt: new Date(T0 + 2250).toISOString(),
                        outcome: "ok",
                    },
                ],
            },
        });
        expect(JSON.stringify(parts)).not.toContain("secret");
        expect(parts.filter((part) => part.type === "data-subagent-activity")).toHaveLength(1);
    });

    it("keeps a sub-agent display part out", async () => {
        const recorder = timed();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "generate_plan", input: {} });
        await recorder.emit({ type: "data-presentation", source: PLANNER, data: { id: "hidden", content: { kind: "markdown", body: "child" } } });

        expect(presentAt(recorder.finish(), 1).parts).toEqual([
            { type: "data-tool-call", id: "t1", data: { toolCallId: "t1", toolName: "generate_plan", outcome: "incomplete" } },
        ]);
    });

    it("leaves no record for a frame with no invocation id", async () => {
        const recorder = timed();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "generate_plan", input: {} });
        const compaction = { agentId: "conversation-compaction", callPath: ["conversation", "conversation-compaction"] };
        await recorder.emit({ type: "tool-started", source: compaction, toolUseId: "c1", name: "read_file", input: {} });
        await recorder.emit({ type: "tool-finished", source: compaction, toolUseId: "c1", name: "read_file", outcome: "ok" });

        expect(presentAt(recorder.finish(), 1).parts.map((part) => part.type)).toEqual(["data-tool-call"]);
    });

    it("closes an unfinished entry as incomplete", async () => {
        const recorder = timed();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "generate_plan", input: {} });
        await recorder.emit({ type: "tool-started", source: PLANNER, toolUseId: "s1", name: "search_pubmed", input: {} });

        const stored = presentAt(recorder.takeRound([{ role: "assistant", content: "" }]), 0).parts.find((part) => part.type === "data-subagent-activity");
        expect(stored).toMatchObject({
            data: { toolCallId: "t1", entries: [{ tool: "search_pubmed", outcome: "incomplete", startedAt: new Date(T0 + 1000).toISOString() }] },
        });
        expect(stored && "data" in stored ? stored.data.entries[0] : undefined).not.toHaveProperty("endedAt");
    });
});

describe("conversation display recorder — rounds", () => {
    it("gives the user message of the turn at the opening", async () => {
        const { recorder, announced } = harness();
        await recorder.emit({ type: "text-delta", text: "answer" });

        expect(recorder.takeOpening()).toEqual([{ id: announced("user")[0] ?? "", role: "user", parts: [{ type: "text", text: "question", state: "done" }] }]);
    });

    it("gives the parts of each round under one assistant id", async () => {
        const { recorder, announced } = harness();
        await recorder.emit({ type: "text-delta", text: "first" });
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "c1", name: "read_file", input: {} });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "c1", name: "read_file", outcome: "ok" });
        const first = recorder.takeRound([]);
        await recorder.emit({ type: "text-delta", text: "second" });
        const second = recorder.takeRound([]);

        const [assistantId] = announced("assistant");
        if (assistantId === undefined) throw new Error("the harness announced no assistant id");
        expect(announced("assistant")).toHaveLength(1);
        expect(first).toEqual([
            {
                id: assistantId,
                role: "assistant",
                parts: [
                    { type: "text", text: "first", state: "done" },
                    { type: "data-tool-call", id: "c1", data: { toolCallId: "c1", toolName: "read_file", outcome: "ok" } },
                ],
            },
        ]);
        expect(second).toEqual([{ id: assistantId, role: "assistant", parts: [{ type: "text", text: "second", state: "done" }] }]);
    });

    it("takes the text of the assistant message when the round streamed no text", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "c1", name: "read_file", input: {} });

        const round = recorder.takeRound([
            {
                role: "assistant",
                content: [
                    { type: "text", text: "whole answer" },
                    { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: {} },
                ],
            },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { type: "text", value: "x" } }] },
        ]);

        expect(presentAt(round, 0).parts.at(-1)).toEqual({ type: "text", text: "whole answer", state: "done" });
    });

    it("marks a pending approval aborted at the take", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "data-ask", source: TOP, data: { id: "ask-1", title: "Run?", command: "inflexa run", status: "pending" } });

        expect(presentAt(recorder.takeRound([]), 0).parts).toEqual([
            { type: "data-ask", id: "ask-1", data: { id: "ask-1", title: "Run?", command: "inflexa run", status: "aborted" } },
        ]);
    });

    it("gives no message for a round with no part", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "text-delta", text: "taken" });
        recorder.takeRound([]);

        expect(recorder.takeRound([{ role: "tool", content: [] }])).toEqual([]);
    });
});

describe("conversation display recorder — compaction rounds", () => {
    const base: ModelMessage[] = [
        syntheticUserMessage("Reply with the summary."),
        { role: "assistant", content: [{ type: "text", text: "The user compares two groups." }] },
    ];
    const exchange: ModelMessage[] = base.map((message) => markCompactionExchange(message, "c-1"));
    const figures = { id: "c-1", tokensBefore: 162_000, durationMs: 21_000 };

    it("gives no message for an exchange round, and never takes the text of the exchange", async () => {
        const { recorder } = harness();

        expect(recorder.takeRound(exchange)).toEqual([]);
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "c2", name: "read_file", input: {} });
        expect(presentAt(recorder.takeRound(exchange), 0).parts.map((part) => part.type)).toEqual(["data-tool-call"]);
    });

    it("gives the divider of a marker round with the figures of the marker", () => {
        const { recorder } = harness();

        const round = recorder.takeRound([summaryMarkerMessage("The user compares two groups.", { kind: "summary", ...figures })]);

        expect(round).toEqual([{ id: "c-1", role: "system", parts: [{ type: "data-compaction", id: "c-1", data: { ...figures, status: "done" } }] }]);
    });

    it("gives the divider the trigger of the marker", () => {
        const { recorder } = harness();

        const round = recorder.takeRound([summaryMarkerMessage("The user compares two groups.", { kind: "summary", ...figures, trigger: "turn-start" })]);

        expect(presentAt(round, 0).parts).toEqual([{ type: "data-compaction", id: "c-1", data: { ...figures, status: "done", trigger: "turn-start" } }]);
    });

    it("gives the divider of a drop marker with the status failed, after the assistant message of the parts", async () => {
        const { recorder, announced } = harness();
        await recorder.emit({ type: "text-delta", text: "before" });

        const round = recorder.takeRound([dropMarkerMessage({ kind: "drop", ...figures, keptTurns: 2 })]);

        expect(round.map((message) => [message.id, message.role])).toEqual([
            [announced("assistant")[0] ?? "", "assistant"],
            ["c-1", "system"],
        ]);
        expect(presentAt(round, 1).parts).toEqual([{ type: "data-compaction", id: "c-1", data: { ...figures, status: "failed" } }]);
    });

    it("gives a round after a marker round a new assistant id", async () => {
        const { recorder, announced } = harness();
        await recorder.emit({ type: "text-delta", text: "first" });
        const first = recorder.takeRound([]);
        recorder.takeRound([summaryMarkerMessage("summary", { kind: "summary", ...figures })]);
        await recorder.emit({ type: "text-delta", text: "second" });
        const second = recorder.takeRound([]);

        expect(presentAt(second, 0).id).not.toBe(presentAt(first, 0).id);
        expect([presentAt(first, 0).id, presentAt(second, 0).id]).toEqual(announced("assistant"));
        expect(presentAt(second, 0).parts).toEqual([{ type: "text", text: "second", state: "done" }]);
    });
});

describe("conversation display recorder — message ids", () => {
    const figures = { id: "c-1", tokensBefore: 162_000, durationMs: 21_000 };
    const summaryRequest: ModelMessage[] = [
        syntheticUserMessage("Reply with the summary."),
        { role: "assistant", content: [{ type: "text", text: "The user compares two groups." }] },
    ];
    const exchange = summaryRequest.map((message) => markCompactionExchange(message, "c-1"));
    const marker = summaryMarkerMessage("The user compares two groups.", { kind: "summary", ...figures });

    /** The ids of the stored user and assistant messages, in the order of the groups. Two rounds of one message give one id. */
    function storedIds(groups: readonly ConversationUIMessage[][]): { user: string[]; assistant: string[] } {
        const ids = (role: "user" | "assistant") => [...new Set(groups.flat().flatMap((message) => (message.role === role ? [message.id] : [])))];
        return { user: ids("user"), assistant: ids("assistant") };
    }

    function messageStart(messageId: string | undefined, role: "user" | "assistant"): TurnEvent {
        if (messageId === undefined) throw new Error(`the stream announced no ${role} id`);
        return role === "user"
            ? { type: "message-start", messageId, role, text: "question", source: TOP }
            : { type: "message-start", messageId, role, source: TOP };
    }

    it("announces the user id and the assistant id immediately before the first event, and stores the turn under them", async () => {
        const { recorder, forwarded, announced } = harness();
        const first: TurnEvent = { type: "text-delta", text: "I read the file." };
        await recorder.emit(first);
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "c1", name: "read_file", input: {} });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "c1", name: "read_file", outcome: "ok" });
        const opening = recorder.takeOpening();
        const round = recorder.takeRound([]);
        await recorder.emit({ type: "text-delta", text: "Done." });
        const last = recorder.takeRound([]);

        expect(announced("user")).toHaveLength(1);
        expect(announced("assistant")).toHaveLength(1);
        expect(forwarded.slice(0, 3)).toEqual([messageStart(announced("user")[0], "user"), messageStart(announced("assistant")[0], "assistant"), first]);
        expect(forwarded.filter((event) => event.type === "message-start")).toHaveLength(2);
        expect(storedIds([opening, round, last])).toEqual({ user: announced("user"), assistant: announced("assistant") });
    });

    it("announces the assistant id of the rounds after a marker immediately before the next event", async () => {
        const { recorder, forwarded, announced } = harness();
        const before: TurnEvent = { type: "text-delta", text: "before" };
        await recorder.emit(before);
        const groups = [recorder.takeOpening(), recorder.takeRound([])];
        const running: TurnEvent = { type: "data-compaction", source: TOP, data: { ...figures, status: "running" } };
        const done: TurnEvent = { type: "data-compaction", source: TOP, data: { ...figures, status: "done" } };
        await recorder.emit(running);
        groups.push(recorder.takeRound(exchange));
        await recorder.emit(done);
        groups.push(recorder.takeRound([marker]));
        const atMarker = forwarded.length;
        const after: TurnEvent = { type: "text-delta", text: "after" };
        await recorder.emit(after);
        groups.push(recorder.takeRound([]));

        const [firstId, secondId] = announced("assistant");
        expect(announced("assistant")).toHaveLength(2);
        expect(secondId).not.toBe(firstId);
        expect(forwarded.slice(0, atMarker)).toEqual([messageStart(announced("user")[0], "user"), messageStart(firstId, "assistant"), before, running, done]);
        expect(forwarded.slice(atMarker)).toEqual([messageStart(secondId, "assistant"), after]);
        expect(storedIds(groups)).toEqual({ user: announced("user"), assistant: announced("assistant") });
    });

    it("forwards nothing before the first event, thus the first call of the sink comes with the first event", async () => {
        const { recorder, forwarded, announced } = harness();
        const opening = recorder.takeOpening();
        const rounds = [recorder.takeRound(exchange), recorder.takeRound([marker])];

        expect(forwarded).toEqual([]);

        const first: TurnEvent = { type: "tool-started", source: TOP, toolUseId: "c1", name: "read_file", input: {} };
        await recorder.emit(first);
        rounds.push(recorder.takeRound([]));

        // The marker changed the assistant id before any event, thus the stream never names the earlier id.
        expect(forwarded).toEqual([messageStart(announced("user")[0], "user"), messageStart(announced("assistant")[0], "assistant"), first]);
        expect(storedIds([opening, ...rounds])).toEqual({ user: announced("user"), assistant: announced("assistant") });
    });

    it("forwards each event of a sub-agent unchanged, and gives each message-start the source of the root agent", async () => {
        const { recorder, forwarded, announced } = harness();
        const started: TurnEvent = { type: "tool-started", source: SUB, toolUseId: "s1", name: "search_pubmed", input: { query: "TP53" } };
        const card: TurnEvent = { type: "data-presentation", source: SUB, data: { id: "hidden", content: { kind: "markdown", body: "child" } } };
        await recorder.emit(started);
        await recorder.emit(card);

        expect(forwarded).toEqual([messageStart(announced("user")[0], "user"), messageStart(announced("assistant")[0], "assistant"), started, card]);
        expect(forwarded[2]).toBe(started);
        expect(forwarded[3]).toBe(card);
    });
});
