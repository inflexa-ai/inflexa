import { scriptedModel } from "../../testing.js";
import type { ChatProvider } from "../types.js";

/**
 * A chat provider that no test drives: the workflow under test reads it into
 * its step arguments, and the test replaces the callable that would consume it.
 * A request fails, because its script holds no reply.
 */
export function unusedChatProvider(): ChatProvider {
    return scriptedModel([]).provider;
}
