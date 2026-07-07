import { describe, expect, it } from "bun:test";
import type {
    LanguageModelV4,
    LanguageModelV4CallOptions,
    LanguageModelV4GenerateResult,
    LanguageModelV4StreamResult,
    LanguageModelV4Usage,
} from "@ai-sdk/provider";

import { makeSession } from "./__fixtures__/session.js";
import { createAiSdkProvider, createConfiguredAiSdkProvider } from "./ai-sdk.js";
import type { ChatRequest } from "./types.js";

const usage: LanguageModelV4Usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function okResult(text = "ok"): LanguageModelV4GenerateResult {
    return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
    };
}

function streamResult(deltas: readonly string[]): LanguageModelV4StreamResult {
    return {
        stream: new ReadableStream({
            start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "txt-1" });
                for (const delta of deltas) {
                    controller.enqueue({ type: "text-delta", id: "txt-1", delta });
                }
                controller.enqueue({ type: "text-end", id: "txt-1" });
                controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
                controller.close();
            },
        }),
    };
}

function fakeModel(
    impl: (options: LanguageModelV4CallOptions) => Promise<LanguageModelV4GenerateResult>,
    streamImpl?: (options: LanguageModelV4CallOptions) => Promise<LanguageModelV4StreamResult>,
): LanguageModelV4 {
    return {
        specificationVersion: "v4",
        provider: "fake-provider",
        modelId: "fake-model",
        supportedUrls: {},
        doGenerate: impl,
        doStream:
            streamImpl ??
            (async () => {
                throw new Error("streaming is not used in these tests");
            }),
    };
}

const request: ChatRequest = {
    system: "You are a test model.",
    messages: [{ role: "user", content: "hello" }],
    tools: {},
};

describe("createAiSdkProvider", () => {
    it("runs an embedder-supplied AI SDK language model and applies billing headers", async () => {
        const calls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(async (options) => {
                calls.push(options);
                return okResult("done");
            }),
            resolveBilling: async () => ({ "X-Billing-Context": "bc-test", "X-Billing-Virtual-Key": "vk-test" }),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().message).toEqual({ role: "assistant", content: [{ type: "text", text: "done" }] });
        expect(calls[0]!.headers).toMatchObject({
            "x-billing-context": "bc-test",
            "x-billing-virtual-key": "vk-test",
        });
    });

    it("returns classified ProviderError values for provider failures", async () => {
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                throw Object.assign(new Error("payment required"), { status: 402 });
            }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error).toMatchObject({
                type: "budget",
                retryable: false,
            });
        }
    });

    it("preserves retryability classification for transient upstream failures", async () => {
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                throw Object.assign(new Error("upstream unavailable"), { status: 503 });
            }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(request, makeSession());

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error).toMatchObject({
                type: "provider",
                retryable: true,
            });
        }
    });

    it("rethrows aborts instead of classifying them", async () => {
        const signal = AbortSignal.abort();
        const provider = createAiSdkProvider({
            model: fakeModel(async () => {
                throw new DOMException("aborted", "AbortError");
            }),
            resolveBilling: async () => ({}),
        });

        try {
            const result = await provider.chat(request, makeSession(), signal);
            throw new Error(`expected abort to be rethrown, got a ${result.isOk() ? "ok" : "err"} result`);
        } catch (err) {
            expect(err).toBeInstanceOf(DOMException);
            expect((err as DOMException).name).toBe("AbortError");
        }
    });

    it("streams deltas through the AI SDK streaming primitive", async () => {
        const generateCalls: LanguageModelV4CallOptions[] = [];
        const streamCalls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(
                async (options) => {
                    generateCalls.push(options);
                    return okResult("should not be used");
                },
                async (options) => {
                    streamCalls.push(options);
                    return streamResult(["he", "llo"]);
                },
            ),
            resolveBilling: async () => ({ "X-Billing-Context": "bc-test" }),
        });

        const events = [];
        for await (const event of provider.chatStream(request, makeSession())) {
            events.push(event);
        }

        expect(generateCalls).toHaveLength(0);
        expect(streamCalls).toHaveLength(1);
        expect(streamCalls[0]!.headers).toMatchObject({ "X-Billing-Context": "bc-test" });
        expect(events).toEqual([
            { type: "text-delta", text: "he" },
            { type: "text-delta", text: "llo" },
            {
                type: "done",
                response: {
                    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
                    finishReason: "stop",
                    rawFinishReason: "stop",
                },
            },
        ]);
    });

    it("rejects tool-required agents before the first model call when tool calling is disabled", async () => {
        const calls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(async (options) => {
                calls.push(options);
                return okResult();
            }),
            resolveBilling: async () => ({}),
            capabilities: { toolCalling: false },
        });

        expect(provider.capabilities.toolCalling).toBe(false);
        expect(calls).toHaveLength(0);
    });
});

describe("empty text block sanitization", () => {
    // The Anthropic API 400s on any request containing an empty text block, and
    // the SDK's response assembly produces one whenever a turn goes straight to
    // tool calls — the loop then echoes that assistant message back as history.
    it("strips empty text parts from echoed history before the wire call", async () => {
        const calls: LanguageModelV4CallOptions[] = [];
        const provider = createAiSdkProvider({
            model: fakeModel(async (options) => {
                calls.push(options);
                return okResult("done");
            }),
            resolveBilling: async () => ({}),
        });

        const result = await provider.chat(
            {
                system: "You are a test model.",
                messages: [
                    { role: "user", content: "profile the files" },
                    {
                        role: "assistant",
                        content: [
                            { type: "text", text: "" },
                            { type: "tool-call", toolCallId: "tc-1", toolName: "execute_command", input: { command: "ls" } },
                        ],
                    },
                    {
                        role: "tool",
                        content: [{ type: "tool-result", toolCallId: "tc-1", toolName: "execute_command", output: { type: "text", value: "ok" } }],
                    },
                    { role: "assistant", content: "" },
                ],
                tools: {},
            },
            makeSession(),
        );

        expect(result.isOk()).toBe(true);
        const textParts = calls[0]!.prompt.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === "text") : []));
        for (const part of textParts) {
            expect(part.text).not.toBe("");
        }
        // The tool call survives the strip; the all-empty assistant message is dropped whole.
        const json = JSON.stringify(calls[0]!.prompt);
        expect(json).toContain("tc-1");
        expect(json).not.toContain('"text":""');
    });
});

describe("createConfiguredAiSdkProvider", () => {
    it("constructs an OpenAI-compatible provider from endpoint/key/model configuration", () => {
        const provider = createConfiguredAiSdkProvider({
            config: {
                kind: "openai-compatible",
                name: "self-hosted",
                baseURL: "http://models.local/v1",
                apiKey: "test-key",
                model: "local-tool-model",
                capabilities: { toolCalling: true },
            },
            resolveBilling: async () => ({}),
        });

        expect(provider.capabilities.toolCalling).toBe(true);
    });
});
