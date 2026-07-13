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

// The user turn's body rides a left border rule; the border glyph eats one gutter cell, so the body pads
// by space.sm (1) inside the box instead of space.md (2) to land in the SAME column as an assistant body.
// This pins that alignment invariant: break the border-1 + padding-1 === md arithmetic and the two body
// texts stop starting in the same column. Rendered together so the columns share one coordinate system.
describe("MessageBlock user-turn left rule alignment", () => {
    /** Column (0-based) at which `needle` starts on its frame row, or -1 if not found. */
    function columnOf(frame: string, needle: string): number {
        for (const line of frame.split("\n")) {
            const idx = line.indexOf(needle);
            if (idx !== -1) return idx;
        }
        return -1;
    }

    test("a user body and an assistant body start in the same column, and the user body carries the border glyph", async () => {
        const frame = await frameWith(
            () => (
                <box flexDirection="column" width="100%">
                    <MessageBlock index={1} role="user" parts={[textPart("USERBODY")]} streamPartId={() => null} streamText={() => ""} />
                    <MessageBlock index={2} role="assistant" parts={[textPart("ASSTBODY")]} streamPartId={() => null} streamText={() => ""} />
                </box>
            ),
            "ASSTBODY",
        );
        const userCol = columnOf(frame, "USERBODY");
        const asstCol = columnOf(frame, "ASSTBODY");
        expect(userCol).toBeGreaterThanOrEqual(0);
        expect(asstCol).toBeGreaterThanOrEqual(0);
        expect(userCol).toBe(asstCol);
        // The left rule ("│", U+2502) sits in the gutter of the user body row; the assistant body has none.
        const userRow = frame.split("\n").find((line) => line.includes("USERBODY")) ?? "";
        const asstRow = frame.split("\n").find((line) => line.includes("ASSTBODY")) ?? "";
        expect(userRow).toContain("│");
        expect(asstRow).not.toContain("│");
    });
});
