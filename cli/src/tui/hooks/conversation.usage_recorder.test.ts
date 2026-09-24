import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ok, okAsync } from "neverthrow";
import type { AgentChat, AgentDefinition, ChatTurnResult, LlmUsageRecord, Pool, RunChatTurnParams, UsageRecorder } from "@inflexa-ai/harness";

import { resetHotState, send, type SendSeams } from "./conversation.ts";
import { __resetNoticesForTest } from "./notice.ts";
import { runChatTurn } from "../../modules/harness/turn.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";

// `send` and the engine here are production code, and only the harness turn is a stand-in that keeps the
// values it was handed. The harness suite pins that `runChatTurn` gives the recorder to its loop.

const SID = "s-usage";
const AID = "a-usage";

/** A recorder identity to look for — nothing is recorded here, only forwarded. */
const runtimeRecorder: UsageRecorder = { record: (_r: LlmUsageRecord) => okAsync(undefined) };

/** A stub runtime carrying the ONE recorder a boot would have constructed. The stand-in turn never reads the pool. */
const stubRuntime = {
    pool: {} as unknown as Pool,
    conversation: { provider: { capabilities: { toolCalling: true } } },
    agents: { forThread: () => ok({ id: "conv" } as unknown as AgentDefinition) },
    usageRecorder: runtimeRecorder,
} as unknown as HarnessRuntime;

/** The result of a clean turn, as the harness gives it. */
const ran: ChatTurnResult = {
    kind: "ran",
    outcome: { status: "done", finish: { reason: "stop", cappedOut: false, truncationRecoveries: 0 } },
    opened: true,
    durationMs: 0,
};

/** Send seams whose engine is the real one, over a harness turn that keeps the params it was handed. */
function capturingSeams(captured: RunChatTurnParams[]): SendSeams {
    return {
        runtime: () => stubRuntime,
        runChatTurn: (args) =>
            runChatTurn(args, {
                turn: (_deps, params) => {
                    captured.push(params);
                    return Promise.resolve(ran);
                },
                // No identity: this case is about the recorder, thus the turn stamps no author.
                readAuthor: () => null,
            }),
    };
}

beforeEach(() => resetHotState());
afterEach(() => {
    resetHotState();
    __resetNoticesForTest();
});

describe("the TUI chat turn carries the runtime's usage recorder", () => {
    test("the values the production path composes name the booted runtime's own realization", async () => {
        const captured: RunChatTurnParams[] = [];

        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, capturingSeams(captured));

        expect(captured).toHaveLength(1);
        // Identity, not presence: a `createNoopUsageRecorder()` here would typecheck, would leave every
        // other assertion in the conversation suite green, and would drop every call the turn made.
        expect(captured[0]?.usageRecorder).toBe(runtimeRecorder);
    });

    test("the provider of the turn is the streaming wrapper, not the bare provider of the runtime", async () => {
        const captured: RunChatTurnParams[] = [];

        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, capturingSeams(captured));

        const provider: AgentChat | undefined = captured[0]?.chat(() => {});
        expect(provider).toBeDefined();
        expect(provider).not.toBe(stubRuntime.conversation.provider);
    });
});
