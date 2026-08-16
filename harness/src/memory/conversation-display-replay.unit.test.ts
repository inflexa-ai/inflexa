import { describe, expect, it } from "bun:test";

import { envelopeMessage } from "./ai-sdk-message-storage.js";
import { storedMessagesToCortex } from "./conversation-display-replay.js";
import { createConversationDisplayRecorder } from "./conversation-display-recorder.js";
import { envelopeDisplayMessages } from "./conversation-display-storage.js";

const SOURCE = { agentId: "conversation", callPath: ["conversation"] };

describe("recorded conversation display replay", () => {
    it("preserves mixed ordering and every durable conversation data family", async () => {
        const recorder = createConversationDisplayRecorder({
            userText: "show everything",
            topLevelCallPath: SOURCE.callPath,
            sink: () => {},
            userMessageId: "user-display",
            assistantMessageId: "assistant-display",
        });

        await recorder.emit({ type: "text-delta", text: "before" });
        await recorder.emit({
            type: "data-plan",
            source: SOURCE,
            data: { id: "plan-card", planId: "pln-abcdef12", title: "Plan" },
        });
        await recorder.emit({
            type: "data-run-card",
            source: SOURCE,
            data: { id: "run-card", runId: "run-1", planId: "pln-abcdef12", title: "Run", stepCount: 2 },
        });
        await recorder.emit({
            type: "data-presentation",
            source: SOURCE,
            data: { id: "presentation", content: { kind: "markdown", body: "Finding" } },
        });
        await recorder.emit({
            type: "data-file-reference",
            source: SOURCE,
            data: { id: "files", files: [{ path: "runs/run-1/output/result.csv", runId: "run-1" }] },
        });
        await recorder.emit({
            type: "data-report-preview",
            source: SOURCE,
            data: { id: "preview", previewId: "preview-1", version: 1, title: "Report", previewPath: "index.html", format: "html" },
        });
        await recorder.emit({
            type: "data-report-preview-failed",
            source: SOURCE,
            data: { id: "preview-failed", previewId: "preview-2", version: 2, reason: "failed", errorKind: "render" },
        });
        await recorder.emit({
            type: "data-ask",
            source: SOURCE,
            data: { id: "ask", title: "Proceed?", command: "inflexa run", status: "resolved" },
        });
        await recorder.emit({ type: "text-delta", text: "after" });

        const display = recorder.finish();
        const model = { role: "user" as const, content: "show everything" };
        const replay = storedMessagesToCortex([
            {
                seq: 0,
                envelope: envelopeMessage(model),
                message: model,
                displayEnvelope: envelopeDisplayMessages(display),
            },
        ]);

        expect(replay[1]!.parts.map((part) => part.type)).toEqual([
            "text",
            "data-plan",
            "data-run-card",
            "data-presentation",
            "data-file-reference",
            "data-report-preview",
            "data-report-preview-failed",
            "data-ask",
            "text",
        ]);
    });

    it("replays a call's outcome and its detail exactly as shown", async () => {
        const recorder = createConversationDisplayRecorder({
            userText: "run it",
            topLevelCallPath: SOURCE.callPath,
            sink: () => {},
            userMessageId: "u",
            assistantMessageId: "a",
        });
        await recorder.emit({ type: "tool-started", source: SOURCE, toolUseId: "t1", name: "read_file", input: {}, detail: "scripts/run.py" });
        await recorder.emit({ type: "tool-finished", source: SOURCE, toolUseId: "t1", name: "read_file", outcome: "ok", detail: "scripts/run.py" });
        await recorder.emit({ type: "tool-started", source: SOURCE, toolUseId: "t2", name: "execute_command", input: {} });
        await recorder.emit({ type: "tool-finished", source: SOURCE, toolUseId: "t2", name: "execute_command", outcome: "denied" });

        const model = { role: "user" as const, content: "run it" };
        const replay = storedMessagesToCortex([
            { seq: 0, envelope: envelopeMessage(model), message: model, displayEnvelope: envelopeDisplayMessages(recorder.finish()) },
        ]);

        // A denial is the user's decision, not a fault — it must not read back as one.
        expect(replay[1]!.parts).toEqual([
            { type: "tool-call", toolCallId: "t1", toolName: "read_file", outcome: "ok", detail: "scripts/run.py" },
            { type: "tool-call", toolCallId: "t2", toolName: "execute_command", outcome: "denied" },
        ]);
    });

    it("replays a call cut off mid-flight as incomplete, never as a success", async () => {
        const recorder = createConversationDisplayRecorder({
            userText: "run it",
            topLevelCallPath: SOURCE.callPath,
            sink: () => {},
            userMessageId: "u",
            assistantMessageId: "a",
        });
        await recorder.emit({ type: "tool-started", source: SOURCE, toolUseId: "t1", name: "read_file", input: {}, detail: "scripts/run.py" });

        const model = { role: "user" as const, content: "run it" };
        const replay = storedMessagesToCortex([
            { seq: 0, envelope: envelopeMessage(model), message: model, displayEnvelope: envelopeDisplayMessages(recorder.finish({ interrupted: true })) },
        ]);

        // One field, four states: a reader switches on it and the compiler catches a missed
        // case. Nothing here is left for a consumer to infer from an absent value.
        expect(replay[1]!.parts).toEqual([{ type: "tool-call", toolCallId: "t1", toolName: "read_file", outcome: "incomplete", detail: "scripts/run.py" }]);
        expect(replay[1]!.interrupted).toBe(true);
    });

    it("folds a stored rollup onto the append's assistant reply", () => {
        const user = { role: "user" as const, content: "q" };
        const assistant = { role: "assistant" as const, content: "a" };
        const usage = { inputTokens: 10, outputTokens: 5 };
        const replay = storedMessagesToCortex([
            {
                seq: 0,
                envelope: envelopeMessage(user),
                message: user,
                displayEnvelope: envelopeDisplayMessages([
                    { id: "u", role: "user", parts: [{ type: "text", text: "q" }] },
                    { id: "a", role: "assistant", parts: [{ type: "text", text: "a" }] },
                ]),
            },
            { seq: 1, envelope: envelopeMessage(assistant), message: assistant, usage },
        ]);

        expect(replay.map((m) => m.usage)).toEqual([undefined, usage]);
    });

    it("folds a stored duration onto the append's assistant reply, beside the rollup", () => {
        const user = { role: "user" as const, content: "q" };
        const assistant = { role: "assistant" as const, content: "a" };
        const usage = { inputTokens: 10, outputTokens: 5 };
        const replay = storedMessagesToCortex([
            {
                seq: 0,
                envelope: envelopeMessage(user),
                message: user,
                displayEnvelope: envelopeDisplayMessages([
                    { id: "u", role: "user", parts: [{ type: "text", text: "q" }] },
                    { id: "a", role: "assistant", parts: [{ type: "text", text: "a" }] },
                ]),
            },
            { seq: 1, envelope: envelopeMessage(assistant), message: assistant, usage, durationMs: 4321 },
        ]);

        expect(replay.map((m) => m.durationMs)).toEqual([undefined, 4321]);
        expect(replay.map((m) => m.usage)).toEqual([undefined, usage]);
    });

    it("folds a duration that no rollup accompanies, and keeps a measured zero", () => {
        const user = { role: "user" as const, content: "q" };
        const assistant = { role: "assistant" as const, content: "a" };
        const replay = storedMessagesToCortex([
            {
                seq: 0,
                envelope: envelopeMessage(user),
                message: user,
                displayEnvelope: envelopeDisplayMessages([
                    { id: "u", role: "user", parts: [{ type: "text", text: "q" }] },
                    { id: "a", role: "assistant", parts: [{ type: "text", text: "a" }] },
                ]),
            },
            { seq: 1, envelope: envelopeMessage(assistant), message: assistant, durationMs: 0 },
        ]);

        // A turn that reported no quantity still took time, thus the two figures are
        // independent. A measured zero is a figure, and it never reads as an absence.
        expect(replay[1]!.durationMs).toBe(0);
        expect("usage" in replay[1]!).toBe(false);
    });

    it("skips a row with no stored projection rather than reconstructing one", () => {
        const model = { role: "user" as const, content: "written before display was persisted" };
        expect(storedMessagesToCortex([{ seq: 0, envelope: envelopeMessage(model), message: model }])).toEqual([]);
    });
});
