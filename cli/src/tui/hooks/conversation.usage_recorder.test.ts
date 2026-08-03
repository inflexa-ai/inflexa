import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import type { AgentChat, AgentDefinition, AgentSession, LlmUsageRecord, ModelMessage, Pool, UsageRecorder } from "@inflexa-ai/harness";

import { resetHotState, send, type SendSeams } from "./conversation.ts";
import { __resetNoticesForTest } from "./notice.ts";
import { runChatTurn, type ChatTurnSeams } from "../../modules/harness/turn.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";

// The chat turn's LLM calls went unrecorded for a whole release, and the scenario that claimed to
// cover them passed throughout: it handed `runChatTurn` a fake `runAgent` and asserted the fake was
// called. That can never see the defect, because the defect is a MISSING FIELD in the options bag
// production composes — `runAgent` reads its recorder from those options, never off the agent
// definition, and silently falls back to the harness no-op when the field is absent. The turn still
// succeeds, the header still shows a figure (that comes from the finish rollup, not the ledger), and
// nothing is written.
//
// So this file asserts on the options bag, and every link that fills it is production code: `send` is
// the real TUI caller and builds the `RunChatTurnArgs` off the runtime handle, `runChatTurn` is the
// real engine and composes the options from those args, and only the `runAgent` seam is a stand-in —
// there purely to CAPTURE what it was handed. Nothing the assertion depends on was written by a test.
//
// `usage_ledger.test.ts` closes the other end with the real `runAgent`, the real recorder, and a real
// persisted row; between them the path from the booted runtime's one realization to a ledger row is
// covered without a fake anywhere on it.

const SID = "s-usage";
const AID = "a-usage";

/** A recorder identity to look for — nothing is recorded here, only forwarded. */
const runtimeRecorder: UsageRecorder = { record: (_r: LlmUsageRecord) => {} };

/**
 * A stub runtime carrying the ONE recorder a boot would have constructed.
 *
 * `pool` rejects rather than being an unusable `{}`: the real engine appends the turn through it, and
 * a rejected connect is what the harness's `withTransaction` turns into a clean `DbError` on the
 * outcome. The turn's fate and its persistence fault are orthogonal by design, so the append failing
 * leaves the accounting path — the one under test — untouched.
 */
const stubRuntime = {
    pool: { connect: () => Promise.reject(new Error("no postgres in this test")) } as unknown as Pool,
    conversation: { provider: { capabilities: { toolCalling: true } } },
    agents: { forThread: () => ok({ id: "conv" } as unknown as AgentDefinition) },
    usageRecorder: runtimeRecorder,
} as unknown as HarnessRuntime;

const userMessage: ModelMessage = { role: "user", content: "hi" };
const prepareOk: ChatTurnSeams["prepare"] = () => Promise.resolve({ kind: "ok", threadType: "conversation", messages: [userMessage], userMessage });

beforeEach(() => resetHotState());
afterEach(() => {
    resetHotState();
    // The rejecting `pool` above makes every turn here fail its append, and `send` answers that with a
    // 4-second warn toast. `notice.ts` is a module singleton whose timer outlives this file, and every
    // test file shares one process, so the toast would still be showing when the next file's first test
    // reads the channel — and a queued notice waits behind a live timer rather than taking the slot.
    __resetNoticesForTest();
});

describe("the TUI chat turn's runAgent options carry the runtime's usage recorder", () => {
    test("the options the production path composes name the booted runtime's own realization", async () => {
        let captured: Parameters<ChatTurnSeams["run"]>[3] | undefined;
        const seams: SendSeams = {
            runtime: () => stubRuntime,
            // The REAL engine, with only the loop captured. `prepare` is stood in for because it is a
            // Postgres round-trip; it sits before the options are composed and cannot affect them.
            runChatTurn: (args) =>
                runChatTurn(args, {
                    prepare: prepareOk,
                    run: (_agent: AgentDefinition, initial: readonly ModelMessage[], _session: AgentSession, opts) => {
                        captured = opts;
                        return Promise.resolve({ messages: [...initial], finish: { reason: "stop" as const, cappedOut: false, truncationRecoveries: 0 } });
                    },
                }),
        };

        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);

        expect(captured).toBeDefined();
        // Identity, not presence: a `createNoopUsageRecorder()` here would typecheck, would leave every
        // other assertion in the conversation suite green, and would drop every call the turn made.
        expect(captured?.usageRecorder).toBe(runtimeRecorder);
    });

    test("the provider handed to the loop is the streaming wrapper, so the recorder rides the real turn", async () => {
        // Guards the shape of the claim above: capturing options from a path that never reached the
        // real turn would prove nothing, so pin that the bag is the live one — the streaming wrapper
        // `send` builds per turn, not the runtime's bare provider.
        let captured: Parameters<ChatTurnSeams["run"]>[3] | undefined;
        const seams: SendSeams = {
            runtime: () => stubRuntime,
            runChatTurn: (args) =>
                runChatTurn(args, {
                    prepare: prepareOk,
                    run: (_agent: AgentDefinition, initial: readonly ModelMessage[], _session: AgentSession, opts) => {
                        captured = opts;
                        return Promise.resolve({ messages: [...initial], finish: { reason: "stop" as const, cappedOut: false, truncationRecoveries: 0 } });
                    },
                }),
        };

        await send({ sessionId: SID, analysisId: AID, userText: "hi" }, seams);

        const provider = captured?.provider as AgentChat | undefined;
        expect(provider).toBeDefined();
        expect(provider).not.toBe(stubRuntime.conversation.provider);
    });
});
