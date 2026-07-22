import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import {
    HARNESS_PROVIDER_NAMESPACE,
    INTERRUPTED_MESSAGE_KEY,
    isInterruptedMessage,
    markInterruptedMessage,
    SYNTHETIC_MESSAGE_KEY,
    syntheticUserMessage,
} from "./ai-sdk-message-storage.js";

describe("interruption marker helpers", () => {
    it("marks a message so isInterruptedMessage reports true", () => {
        const marked = markInterruptedMessage({ role: "assistant", content: "partial" });
        expect(isInterruptedMessage(marked)).toBe(true);
    });

    it("reads an unmarked message as not interrupted", () => {
        expect(isInterruptedMessage({ role: "assistant", content: "a clean reply" })).toBe(false);
    });

    it("returns a copy without mutating the input", () => {
        const original: ModelMessage = { role: "assistant", content: "partial" };
        const marked = markInterruptedMessage(original);
        expect(marked).not.toBe(original);
        // The input keeps no marker — mark is pure.
        expect(original.providerOptions).toBeUndefined();
        expect(isInterruptedMessage(original)).toBe(false);
    });

    it("preserves an existing provider namespace on the message when marking", () => {
        const withSignature: ModelMessage = {
            role: "assistant",
            content: "partial",
            providerOptions: { anthropic: { signature: "SIG-abc" } },
        };
        const marked = markInterruptedMessage(withSignature);

        expect(isInterruptedMessage(marked)).toBe(true);
        // The pre-existing anthropic namespace is untouched — merge, not replace.
        expect(marked.providerOptions?.anthropic).toEqual({ signature: "SIG-abc" });
        expect(marked.providerOptions?.[HARNESS_PROVIDER_NAMESPACE]?.[INTERRUPTED_MESSAGE_KEY]).toBe(true);
    });

    it("merges into an existing harness namespace rather than dropping its other keys", () => {
        // Marking keeps every key already present in the harness namespace.
        const synthetic = syntheticUserMessage("continue concisely");
        const marked = markInterruptedMessage(synthetic);

        const harness = marked.providerOptions?.[HARNESS_PROVIDER_NAMESPACE];
        expect(harness?.[SYNTHETIC_MESSAGE_KEY]).toBe(true);
        expect(harness?.[INTERRUPTED_MESSAGE_KEY]).toBe(true);
    });
});
