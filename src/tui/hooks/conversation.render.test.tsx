import { afterEach, describe, expect, test } from "bun:test";
import { For } from "solid-js";
import { testRender } from "@opentui/solid";

import { MessageBlock } from "../layout/message_block.tsx";
import { applyBusEvent, messages, streamText, streamPartId, resetHotState } from "./conversation.ts";
import type { BusEvent } from "../../types/events.ts";

// Render-level regression for "streamed text vanishes when the turn finishes" (the symptom: live
// tokens show, then blank at idle). This class of bug only manifests under the real renderer's
// scheduling — a store-only unit test passes even when broken — so it MUST drive testRender. It
// exercises the exact engine pattern: ONE Part object reused across emits and mutated `.text`
// out-of-band before the final emit (chat.ts). The store must own copies, or the finalized text
// strands off-screen. The markdown parse is async, so we poll frames for the expected text.
const SID = "s1";
const ev = (e: BusEvent): void => applyBusEvent(e, SID);

afterEach(() => resetHotState());

describe("streamed assistant text survives finalization (rendered)", () => {
    test("the reply is visible after session.status idle, not just mid-stream", async () => {
        resetHotState();
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <For each={messages}>{(m) => <MessageBlock role={m.role} parts={m.parts} streamPartId={streamPartId} streamText={streamText} />}</For>
                </box>
            ),
            { width: 50, height: 16 },
        );
        // Render frames on real timers until `frame` contains `needle`, or fail after `timeoutMs` —
        // the markdown renderable parses asynchronously, so the text appears a frame or two later.
        const frameWith = async (needle: string, timeoutMs = 2000): Promise<string> => {
            const start = Date.now();
            for (;;) {
                await setup.renderOnce();
                const f = setup.captureCharFrame();
                if (f.includes(needle) || Date.now() - start > timeoutMs) return f;
                await new Promise((r) => setTimeout(r, 10));
            }
        };
        try {
            ev({ type: "message.created", message: { id: "a1", sessionId: SID, role: "assistant", createdAt: 0 } });
            // Same object reused across emits, exactly as the engine does.
            const pa: { id: string; sessionId: string; messageId: string; type: "text"; text: string; createdAt: number } = {
                id: "pa1",
                sessionId: SID,
                messageId: "a1",
                type: "text",
                text: "",
                createdAt: 0,
            };
            ev({ type: "part.updated", part: pa });
            ev({ type: "part.delta", sessionId: SID, messageId: "a1", partId: "pa1", delta: "streamed reply" });

            expect(await frameWith("streamed reply")).toContain("streamed reply"); // live streaming visible

            pa.text = "streamed reply"; // out-of-band mutate (chat.ts persists via this object)
            ev({ type: "part.updated", part: pa });
            ev({ type: "session.status", sessionId: SID, status: "idle" });

            expect(await frameWith("streamed reply")).toContain("streamed reply"); // STILL visible after finalize
        } finally {
            setup.renderer.destroy();
        }
    });
});
