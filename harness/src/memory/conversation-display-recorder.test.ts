import { describe, expect, it } from "bun:test";

import type { EmitFn } from "../loop/types.js";
import { createConversationDisplayRecorder } from "./conversation-display-recorder.js";

const TOP = { agentId: "conversation", callPath: ["conversation"] };
const SUB = { agentId: "child", callPath: ["conversation", "child"] };

function harness() {
    const forwarded: Parameters<EmitFn>[0][] = [];
    const recorder = createConversationDisplayRecorder({
        userText: "question",
        topLevelCallPath: TOP.callPath,
        sink: (event) => {
            forwarded.push(event);
        },
        userMessageId: "u1",
        assistantMessageId: "a1",
    });
    return { recorder, forwarded };
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
        expect(display[1]!.parts).toEqual([
            { type: "text", text: "before", state: "done" },
            { type: "data-presentation", id: "p1", data: { id: "p1", content: { kind: "markdown", body: "card" } } },
            { type: "text", text: "after", state: "done" },
        ]);
        expect(forwarded).toHaveLength(3);
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

        expect(recorder.finish()[1]!.parts.map((part) => ("id" in part ? part.id : part.type))).toEqual(["a", "b", "from-b", "from-a"]);
    });

    it("records a child-session-started part in the position of its emission", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "text-delta", text: "starting" });
        await recorder.emit({ type: "data-child-session-started", source: TOP, data: { threadId: "r1", parentThreadId: "p1", threadType: "report" } });
        await recorder.emit({ type: "text-delta", text: "done" });

        // The part is durable conversation display, thus the recorder keeps it
        // between the two text runs and a reload shows it where the spawn ran.
        const display = recorder.finish();
        expect(display[1]!.parts).toEqual([
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
        expect(display[1]!.parts).toEqual([
            { type: "text", text: "rendering", state: "done" },
            { type: "data-report-rendered", id: "rr1", data: { id: "rr1", renderedAt: "2026-08-18T00:00:00.000Z", title: "Report" } },
            { type: "text", text: "done", state: "done" },
        ]);
    });

    it("records each call's outcome and detail as shown, denial distinct from failure", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "r", name: "read_file", input: {}, detail: "scripts/run.py" });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "r", name: "read_file", outcome: "ok", detail: "scripts/run.py" });
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "x", name: "execute_command", input: {} });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "x", name: "execute_command", outcome: "denied" });
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "e", name: "grep", input: {} });
        await recorder.emit({ type: "tool-finished", source: TOP, toolUseId: "e", name: "grep", outcome: "error" });

        expect(recorder.finish()[1]!.parts).toEqual([
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

        expect(recorder.finish()[1]!.parts).toEqual([{ type: "data-ask", id: "ask-1", data: { ...base, status: "resolved" } }]);
    });

    it("leaves an unfinished call incomplete on interruption", async () => {
        const { recorder } = harness();
        await recorder.emit({ type: "tool-started", source: TOP, toolUseId: "call-1", name: "execute_analysis", input: { mode: "plan" } });
        await recorder.emit({
            type: "data-ask",
            source: TOP,
            data: { id: "ask-interrupted", title: "Run?", command: "inflexa run", status: "pending" },
        });

        const assistant = recorder.finish({ interrupted: true })[1]!;
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
        expect(recorder.finish({ fallbackText: "whole answer" })[1]!.parts).toEqual([{ type: "text", text: "whole answer", state: "done" }]);

        const streamed = harness().recorder;
        await streamed.emit({ type: "text-delta", text: "streamed" });
        expect(streamed.finish({ fallbackText: "streamed in full" })[1]!.parts).toEqual([{ type: "text", text: "streamed", state: "done" }]);
    });
});
