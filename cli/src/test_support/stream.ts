import type { ChatFrame } from "@inflexa-ai/harness/contracts/index.js";
import { ok, type Result } from "neverthrow";

import type { ClientError } from "../client/api.ts";

/**
 * An `AsyncGenerator` that yields each item of `items` in order and then ends, for a test double of a
 * stream whose consumer type is `AsyncGenerator` (a chat turn, a conversation read).
 */
// oxlint-disable-next-line typescript/require-await -- an AsyncGenerator over a fixed list has nothing to await, and the consumer types require an AsyncGenerator
export async function* streamOf<T>(items: Iterable<T>): AsyncGenerator<T> {
    yield* items;
}

/**
 * The frame stream of one turn, for a test double of the chat route. Each frame is copied (`structuredClone`),
 * thus a later change of the frame by the sender cannot reach a queued frame. `send` resolves when the
 * reader asks for the next frame, which is after the consumer applied the frame: the generator yields the
 * frame, then calls `applied`. A test relies on that order to know that the hook applied what it sent.
 */
export function frameChannel(): {
    send: (frame: ChatFrame) => Promise<void>;
    close: () => void;
    frames: AsyncGenerator<Result<ChatFrame, ClientError>>;
} {
    const waiting: { frame: ChatFrame; applied: () => void }[] = [];
    let closed = false;
    let wake: (() => void) | null = null;
    const notify = (): void => {
        const resume = wake;
        wake = null;
        resume?.();
    };
    async function* frames(): AsyncGenerator<Result<ChatFrame, ClientError>> {
        for (;;) {
            const item = waiting.shift();
            if (item !== undefined) {
                // typecheck-disable-next-line must-use-result -- a yielded Result is consumed by the `for await` of the caller, which the rule cannot follow
                yield ok(item.frame);
                item.applied();
                continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
        }
    }
    return {
        send: (frame) =>
            new Promise<void>((applied) => {
                waiting.push({ frame: structuredClone(frame), applied });
                notify();
            }),
        close: () => {
            closed = true;
            notify();
        },
        frames: frames(),
    };
}
