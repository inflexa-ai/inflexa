/**
 * Transcript integrity for tool calls.
 *
 * The wire contract of every provider is that each tool call in an assistant
 * message has a matching tool result. A transcript that violates it is refused
 * WHOLE — the AI SDK throws at prompt conversion, and the Anthropic API answers
 * 400 — so a single unanswered call makes a thread unable to take any further
 * turn. An unanswered call is a reachable state, not a hypothetical: a reply
 * can carry a complete tool call beside ANY finish reason, because the call
 * streams before the stop reason arrives, and only a `tool-calls` (and, for its
 * leading calls, a `length`) finish dispatches it.
 *
 * The repair only appends an answer; it never edits or removes a message,
 * because a signed thinking block and the prompt cache both key on the exact
 * prior prefix.
 */

import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";

export const NOT_RUN_TOOL_RESULT = "Not run: the turn ended before this call ran.";

export function notRunResult(call: Pick<ToolCallPart, "toolCallId" | "toolName">): ToolResultPart {
    return {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "error-text", value: NOT_RUN_TOOL_RESULT },
    };
}

/** One tool call that {@link answerUnansweredToolCalls} answered, identified for the caller's diagnostic record. */
export interface AnsweredToolCall {
    readonly toolCallId: string;
    readonly toolName: string;
}

/**
 * Whether this tool call needs a client-supplied result. A provider-executed
 * call is answered by the provider inside the same assistant message, so the
 * wire contract makes no demand on the client for it — the AI SDK's own
 * missing-result validation skips these, and so does the answer.
 */
function needsClientResult(part: ToolCallPart): boolean {
    return part.providerExecuted !== true;
}

/**
 * Answer, in place, every tool call at or past `fromIndex` that has no matching
 * tool result anywhere in `messages`. No message is removed or changed. Returns
 * the answered calls in transcript order — empty on the healthy path — so the
 * caller can log what a reader of the stored thread would otherwise never learn.
 *
 * Results are matched by id across the whole array, not by adjacency: the loop
 * appends a round's results directly after its assistant message, but a
 * deferred-image user message can ride between rounds, and the stored shape is
 * not this function's to assume.
 *
 * `fromIndex` bounds the REPAIR, not the result scan. The loop passes its
 * `initial.length` so it never answers inside the caller's prefix; the history
 * load passes nothing and covers the whole loaded window.
 */
export function answerUnansweredToolCalls(messages: ModelMessage[], fromIndex = 0): AnsweredToolCall[] {
    const resultIds = new Set<string>();
    for (const message of messages) {
        if (message.role === "tool") {
            for (const part of message.content) {
                if (part.type === "tool-result") resultIds.add(part.toolCallId);
            }
        } else if (message.role === "assistant" && typeof message.content !== "string") {
            for (const part of message.content) {
                if (part.type === "tool-result") resultIds.add(part.toolCallId);
            }
        }
    }

    const answered: AnsweredToolCall[] = [];
    // Backward, so an insertion after a message cannot shift an index this walk
    // has yet to visit.
    for (let idx = messages.length - 1; idx >= fromIndex; idx--) {
        const message = messages[idx]!;
        if (message.role !== "assistant" || typeof message.content === "string") continue;
        const unanswered = message.content.filter(
            (part): part is ToolCallPart => part.type === "tool-call" && needsClientResult(part) && !resultIds.has(part.toolCallId),
        );
        if (unanswered.length === 0) continue;
        let insertAt = idx + 1;
        while (insertAt < messages.length && messages[insertAt]!.role === "tool") insertAt++;
        messages.splice(insertAt, 0, { role: "tool", content: unanswered.map((part) => notRunResult(part)) });
        // Prepended as a batch: the walk visits messages tail-first, but the
        // caller's record reads in transcript order.
        answered.unshift(...unanswered.map((part) => ({ toolCallId: part.toolCallId, toolName: part.toolName })));
    }
    return answered;
}
