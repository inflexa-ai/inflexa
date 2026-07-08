import { afterEach, describe, expect, test } from "bun:test";
import { For } from "solid-js";
import { testRender } from "@opentui/solid";

import { MessageBlock } from "../layout/message_block.tsx";
import { messages, send, streamText, streamPartId, resetHotState, type SendSeams } from "./conversation.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";

// Render-level regression for "streamed text vanishes when the turn finishes" (the symptom: live
// tokens show, then blank at completion). This class of bug only manifests under the real renderer's
// scheduling — a store-only unit test passes even when broken — so it MUST drive testRender. It now
// exercises the harness path: `send` mints the assistant message + streaming text part, the adapter
// accumulates deltas into `streamText`, and the ok outcome flushes a FRESH object into the store. The
// markdown parse is async, so we poll frames for the expected text.
const SID = "s1";
const AID = "a1";

// A stub runtime whose pool/provider are never dereferenced (the fake engine never touches them);
// `createStreamingChat` reads only `provider.capabilities` at construction.
const stubRuntime = { pool: {}, provider: { capabilities: { toolCalling: true } }, conversationAgent: {} } as unknown as HarnessRuntime;

afterEach(() => resetHotState());

describe("streamed assistant text survives finalization (rendered)", () => {
    test("the reply is visible mid-stream and after the turn completes", async () => {
        resetHotState();
        const setup = await testRender(
            () => (
                <box flexDirection="column">
                    <For each={messages}>
                        {(m, i) => <MessageBlock index={i() + 1} role={m.role} parts={m.parts} streamPartId={streamPartId} streamText={streamText} />}
                    </For>
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
            // Hold the turn open so we can render mid-stream, then release it to finalize.
            let releaseEngine!: () => void;
            const gate = new Promise<void>((resolve) => {
                releaseEngine = resolve;
            });
            const seams: SendSeams = {
                runtime: () => stubRuntime,
                runChatTurn: async (args) => {
                    void args.emit({ type: "text-delta", text: "streamed reply" });
                    await gate;
                    return { kind: "ok", fallbackText: "" };
                },
            };
            const pending = send({ sessionId: SID, analysisId: AID, userText: "hello" }, seams);

            expect(await frameWith("streamed reply")).toContain("streamed reply"); // live streaming visible

            releaseEngine();
            await pending;

            expect(await frameWith("streamed reply")).toContain("streamed reply"); // STILL visible after finalize
            expect(streamPartId()).toBeNull();
        } finally {
            setup.renderer.destroy();
        }
    });
});
