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
 * The repair is a STRIP, never an invented result. A call that was not
 * dispatched did not happen, and a fabricated result would record an execution
 * that did not occur — the model would read it as ground truth on the next
 * turn. The prose of the message survives the strip; a message left with
 * nothing the wire can render disappears entirely.
 */

import type { ModelMessage, ToolCallPart } from "ai";

/** One tool call removed by {@link stripUnansweredToolCalls}, identified for the caller's diagnostic record. */
export interface DroppedToolCall {
    readonly toolCallId: string;
    readonly toolName: string;
}

/**
 * Whether this tool call needs a client-supplied result. A provider-executed
 * call is answered by the provider inside the same assistant message, so the
 * wire contract makes no demand on the client for it — the AI SDK's own
 * missing-result validation skips these, and so does the strip.
 */
function needsClientResult(part: ToolCallPart): boolean {
    return part.providerExecuted !== true;
}

/**
 * Remove, in place, every tool-call part at or past `fromIndex` that has no
 * matching tool result anywhere in `messages`. Returns the removed calls in
 * transcript order — empty on the healthy path — so the caller can log what
 * a reader of the stored thread would otherwise never learn.
 *
 * Results are matched by id across the whole array, not by adjacency: the loop
 * appends a round's results directly after its assistant message, but a
 * deferred-image user message can ride between rounds, and the stored shape is
 * not this function's to assume.
 *
 * A message that keeps a text or file part survives the strip — refusal prose
 * is the one account the reader has of a filtered reply. A message left with
 * no such part (a call-only message, or reasoning beside the removed call) is
 * removed whole: reasoning without the output it preceded is not replayable,
 * and an empty assistant message is itself a wire violation.
 *
 * `fromIndex` bounds the REPAIR, not the result scan. The loop passes its
 * `initial.length` so it never rewrites the caller's prefix; the assembly
 * repair passes nothing and covers the whole stored window.
 */
export function stripUnansweredToolCalls(messages: ModelMessage[], fromIndex = 0): DroppedToolCall[] {
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

    type AssistantPart = Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>[number];

    const dropped: DroppedToolCall[] = [];
    // Backward, so a whole-message removal cannot shift an index this loop has
    // yet to visit.
    for (let idx = messages.length - 1; idx >= fromIndex; idx--) {
        const message = messages[idx]!;
        if (message.role !== "assistant" || typeof message.content === "string") continue;
        const removed: ToolCallPart[] = [];
        for (const part of message.content) {
            if (part.type === "tool-call" && needsClientResult(part) && !resultIds.has(part.toolCallId)) removed.push(part);
        }
        if (removed.length === 0) continue;
        // Prepended as a batch: the walk visits messages tail-first, but the
        // caller's record reads in transcript order.
        dropped.unshift(...removed.map((part) => ({ toolCallId: part.toolCallId, toolName: part.toolName })));
        const removedParts = new Set<AssistantPart>(removed);
        const kept = message.content.filter((part) => !removedParts.has(part));
        if (kept.some((part) => part.type === "text" || part.type === "file" || part.type === "tool-call" || part.type === "tool-result")) {
            messages[idx] = { ...message, content: kept };
        } else {
            messages.splice(idx, 1);
        }
    }
    return dropped;
}
