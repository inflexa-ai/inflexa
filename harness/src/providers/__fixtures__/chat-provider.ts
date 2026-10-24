import { okAsync } from "neverthrow";

import type { AgentChat, ChatProvider } from "../types.js";

/**
 * A chat provider that no test drives: the workflow under test reads it into
 * its step arguments, and the test replaces the callable that would consume it.
 */
export function unusedChatProvider(): ChatProvider {
    return {
        capabilities: { toolCalling: true },
        chat: () => okAsync({ message: { role: "assistant", content: "" }, finishReason: "stop", requestedModelId: "" }),
        chatStream: () => {
            throw new Error("chatStream: not driven by this test");
        },
    };
}

/**
 * A complete provider double whose `chat` the test scripts. The stream stays an
 * empty generator, the same value the router-path doubles carried before this
 * builder existed.
 */
export function chatProviderDouble(chat: AgentChat["chat"], chatStream: ChatProvider["chatStream"] = async function* () {}): ChatProvider {
    return { capabilities: { toolCalling: true }, chat, chatStream };
}
