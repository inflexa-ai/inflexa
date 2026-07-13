import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import { briefingEnvelope, envelopeMessage, isBriefingEnvelope, parseStoredMessageEnvelope, SUPPORTED_AI_SDK_MAJOR } from "./ai-sdk-message-storage.js";

const wrappedUser: ModelMessage = {
    role: "user",
    content: '<briefing name="data-profile">\n# Data profile\n\nsummary\n</briefing>',
};

describe("briefing envelopes", () => {
    it("round-trips a briefing envelope verbatim through storage serialization", () => {
        const env = briefingEnvelope("data-profile", "3 files · CSV · profiled 2026-06-09", wrappedUser);

        // Simulate the JSONB write/read the messages table performs.
        const reparsed = parseStoredMessageEnvelope(JSON.parse(JSON.stringify(env)), "t/0");

        expect(reparsed.kind).toBe("briefing");
        expect(isBriefingEnvelope(reparsed)).toBe(true);
        expect(reparsed).toEqual(env);
        if (reparsed.kind !== "briefing") throw new Error("unreachable");
        expect(reparsed.name).toBe("data-profile");
        expect(reparsed.caption).toBe("3 files · CSV · profiled 2026-06-09");
        expect(reparsed.message).toEqual(wrappedUser);
    });

    it("marks a model-message envelope as not a briefing", () => {
        const env = parseStoredMessageEnvelope(JSON.parse(JSON.stringify(envelopeMessage({ role: "user", content: "hi" }))), "t/0");
        expect(env.kind).toBe("ai-sdk-model-message");
        expect(isBriefingEnvelope(env)).toBe(false);
    });

    it("treats the stored content as authoritative — no template coupling", () => {
        // A row briefed with an older template keeps its exact bytes; nothing in
        // the reader re-renders from a current definition.
        const oldContent = '<briefing name="data-profile">OLD TEMPLATE TEXT</briefing>';
        const env = briefingEnvelope("data-profile", "old caption", { role: "user", content: oldContent });
        const reparsed = parseStoredMessageEnvelope(JSON.parse(JSON.stringify(env)), "t/0");
        expect(reparsed.message.content).toBe(oldContent);
    });
});

describe("fail-closed validation", () => {
    it("rejects an unknown envelope kind", () => {
        expect(() => parseStoredMessageEnvelope({ kind: "mystery", message: { role: "user", content: "x" } }, "t/0")).toThrow(
            /Invalid stored AI SDK message envelope/,
        );
    });

    it("rejects an unsupported aiSdkMajor on a briefing", () => {
        expect(() =>
            parseStoredMessageEnvelope({ kind: "briefing", name: "n", caption: "c", aiSdkMajor: SUPPORTED_AI_SDK_MAJOR - 1, message: wrappedUser }, "t/0"),
        ).toThrow(/Invalid stored AI SDK message envelope/);
    });

    it("rejects a briefing envelope missing its name", () => {
        expect(() => parseStoredMessageEnvelope({ kind: "briefing", caption: "c", aiSdkMajor: SUPPORTED_AI_SDK_MAJOR, message: wrappedUser }, "t/0")).toThrow(
            /Invalid stored AI SDK message envelope/,
        );
    });
});
