/**
 * One ChatProvider whose stream answers one text delta and one finish that carries the given input-token
 * total and no output tokens. The usage suites feed it to the loop and read the counters back.
 */

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

import { createAiSdkProvider } from "../../providers/ai-sdk.js";
import type { ChatProvider } from "../../providers/types.js";

export function unnamedModel(inputTokens: number): ChatProvider {
    const parts: LanguageModelV4StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "p0" },
        { type: "text-delta", id: "p0", delta: "done" },
        { type: "text-end", id: "p0" },
        {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
        },
    ];
    const model = new MockLanguageModelV4({ provider: "unnamed", doStream: () => Promise.resolve({ stream: convertArrayToReadableStream(parts) }) });
    return createAiSdkProvider({ model, maxRetries: 0 });
}
