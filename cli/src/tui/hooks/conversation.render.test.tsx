import { afterEach, describe, expect, test } from "bun:test";
import { ok, okAsync, type Result } from "neverthrow";
import { For } from "solid-js";
import { testRender } from "@opentui/solid";
import type { ChatFrame } from "@inflexa-ai/harness/contracts/index.js";

import type { ClientError } from "../../client/api.ts";
import { MessageBlock } from "../layout/message_block.tsx";
import { messages, send, streamText, streamPartId, resetHotState, type SendOpts } from "./conversation.ts";

// Render-level regression for "streamed text vanishes when the turn finishes" (the symptom: live
// tokens show, then blank at completion). This class of bug only manifests under the real renderer's
// scheduling — a store-only unit test passes even when broken — so it MUST drive testRender. It
// exercises the turn stream: `send` mints the assistant message + streaming text part, the adapter
// accumulates deltas into `streamText`, and the `done` summary flushes a FRESH object into the store. The
// markdown parse is async, so we poll frames for the expected text.
const SID = "s1";
const AID = "a1";
const ROUTE_SOURCE = { agentId: "chat", callPath: ["chat"] };

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
            // A fake server: its stream sends one delta, parks until released, then ends the turn.
            async function* frames(): AsyncGenerator<Result<ChatFrame, ClientError>> {
                // eslint-disable-next-line neverthrow/must-use-result -- a yielded Result is consumed by the `for await` of the hook, which the rule cannot follow
                yield ok({ type: "text-delta", text: "streamed reply", source: ROUTE_SOURCE });
                await gate;
                // eslint-disable-next-line neverthrow/must-use-result -- a yielded Result is consumed by the `for await` of the hook, which the rule cannot follow
                yield ok({ type: "finish", source: ROUTE_SOURCE });
            }
            const server: SendOpts = {
                startTurn: () => okAsync({ turnId: "turn-1", frames: frames() }),
                abortTurn: (_analysisId, _threadId, turnId) => okAsync({ turnId, outcome: "aborting" }),
                fetchTurn: (analysisId, threadId, turnId) =>
                    okAsync({ turnId, threadId, analysisId, startedAt: "2026-10-02T00:00:00.000Z", status: "done", opened: true }),
                reloadTranscript: async () => undefined,
                transcript: { fetchThread: () => okAsync(null), fetchMessages: () => okAsync({ messages: [], total: 0, page: 0, perPage: 0, hasMore: false }) },
                healRetract: () => okAsync({ kind: "retracted", messages: 0 }),
            };
            const pending = send({ sessionId: SID, analysisId: AID, userText: "hello" }, server);

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
