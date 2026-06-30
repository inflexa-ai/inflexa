import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { MessageBlock } from "./message_block.tsx";
import type { TextPart } from "../../types/session.ts";

// Guards the streaming-vs-finalized markdown bug: @opentui/core's `<markdown streaming={false}>`
// renders nothing, so a finalized/reloaded text part used to vanish the moment the stream ended.
// MessageBlock pins streaming=true; these assert the text survives in BOTH states. The markdown
// uses internalBlockMode="top-level", which parses asynchronously, so we poll frames rather than
// capture a single one.
function textPart(text: string): TextPart {
    return { id: "p1", sessionId: "s1", messageId: "m1", type: "text", text, createdAt: 0 };
}

async function frameWith(node: Parameters<typeof testRender>[0], needle: string, timeoutMs = 2000): Promise<string> {
    const setup = await testRender(node, { width: 40, height: 6 });
    try {
        const start = Date.now();
        for (;;) {
            await setup.renderOnce();
            const f = setup.captureCharFrame();
            if (f.includes(needle) || Date.now() - start > timeoutMs) return f;
            await new Promise((r) => setTimeout(r, 10));
        }
    } finally {
        setup.renderer.destroy();
    }
}

describe("MessageBlock text rendering", () => {
    test("a finalized (non-streaming) text part renders its stored text", async () => {
        const frame = await frameWith(
            () => <MessageBlock index={1} role="assistant" parts={[textPart("finalized answer")]} streamPartId={() => null} streamText={() => ""} />,
            "finalized answer",
        );
        expect(frame).toContain("finalized answer");
    });

    test("a streaming part renders the live stream text, not the (empty) stored text", async () => {
        const frame = await frameWith(
            () => <MessageBlock index={1} role="assistant" parts={[textPart("")]} streamPartId={() => "p1"} streamText={() => "live tokens"} />,
            "live tokens",
        );
        expect(frame).toContain("live tokens");
    });
});
