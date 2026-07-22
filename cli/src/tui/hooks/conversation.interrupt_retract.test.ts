import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { DbError, MessagePage } from "@inflexa-ai/harness";

import {
    abort,
    armInterrupt,
    canRetract,
    type CortexMsg,
    errorMsg,
    interruptArmed,
    loadMessages,
    type LoadSeams,
    messages,
    resetHotState,
    retract,
    type RetractSeams,
    send,
    type SendSeams,
} from "./conversation.ts";
import { chatStatus } from "./status.ts";
import { currentNotice } from "./notice.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { RunChatTurnArgs, TurnOutcome } from "../../modules/harness/turn.ts";

// The conversation state is a module singleton (one chat screen at a time), so reset it between
// cases. `pendingRetract` is the ONE piece resetHotState does not clear (an orphan is thread-scoped,
// not session-scoped), so the durable-fault case below uses its own thread id and lets the heal send
// consume the pending entry — leaving nothing behind for a later case to trip over.
const SID = "s1";
const AID = "a1";
const TOP = { agentId: "tui-chat", callPath: ["tui-chat"] };

// A stub runtime whose pool/provider are never dereferenced: the fake engine drives the adapter and
// returns an outcome without touching them (mirrors conversation.test.ts). `createStreamingChat` reads
// only `provider.capabilities` at construction, so that one field is present.
const stubRuntime = {
    pool: {},
    conversation: { provider: { capabilities: { toolCalling: true } } },
    conversationAgent: {},
} as unknown as HarnessRuntime;

/**
 * A capture cell for the composer seed, read through `.get()` so control flow never narrows it back to
 * its null initializer — the `seedComposer` closure assigns it out of band (the same reason fakeSeams'
 * `last` is a getter in conversation.test.ts).
 */
function seedCell(): { readonly set: (text: string) => void; readonly get: () => string | null } {
    let value: string | null = null;
    return {
        set: (text: string): void => {
            value = text;
        },
        get: () => value,
    };
}

/** Build send seams whose fake engine calls `drive(emit)` then returns `outcome` — the non-parked shape. */
function fakeSeams(outcome: TurnOutcome, drive: (emit: RunChatTurnArgs["emit"]) => void = () => {}): SendSeams {
    return {
        runtime: () => stubRuntime,
        runChatTurn: async (args: RunChatTurnArgs): Promise<TurnOutcome> => {
            drive(args.emit);
            return outcome;
        },
    };
}

/** A turn parked mid-flight: the engine holds at a gate so the retract/interrupt window can be probed. */
type ParkedTurn = {
    readonly sendP: Promise<void>;
    /** The turn's guarded emit sink, captured once the engine parks — races output into the live turn. */
    readonly emit: () => RunChatTurnArgs["emit"];
    /** Release the parked engine so it returns the chosen outcome and the turn settles. */
    readonly release: () => void;
};

/**
 * Start a turn and leave the engine parked at a gate BEFORE it returns. `send` runs synchronously up to
 * `await runChatTurn`, so by the time this returns the module hot state (assistant id, abort controller,
 * `turnSettled`, busy status, the empty assistant shell) is fully armed for a retract/interrupt probe.
 */
function startBusyTurn(outcome: TurnOutcome, sessionId = SID, analysisId = AID): ParkedTurn {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
    });
    let emit!: RunChatTurnArgs["emit"];
    const seams: SendSeams = {
        runtime: () => stubRuntime,
        runChatTurn: async (args: RunChatTurnArgs): Promise<TurnOutcome> => {
            emit = args.emit;
            await gate;
            return outcome;
        },
    };
    const sendP = send({ sessionId, analysisId, userText: "original text" }, seams);
    return { sendP, emit: () => emit, release };
}

beforeEach(() => resetHotState());
afterEach(() => resetHotState());

describe("canRetract gates the retract window", () => {
    test("false before any turn, true during a busy no-output turn", async () => {
        expect(canRetract()).toBe(false);
        const { sendP, release } = startBusyTurn({ kind: "ok", fallbackText: "" });
        expect(canRetract()).toBe(true);
        release();
        await sendP;
        // Back to idle → the window is closed again.
        expect(canRetract()).toBe(false);
    });

    test("flips false the instant a text delta lands", async () => {
        const { sendP, emit, release } = startBusyTurn({ kind: "ok", fallbackText: "" });
        expect(canRetract()).toBe(true);
        void emit()({ type: "text-delta", text: "answering" });
        expect(canRetract()).toBe(false);
        release();
        await sendP;
    });

    test("flips false the instant a tool part starts", async () => {
        const { sendP, emit, release } = startBusyTurn({ kind: "ok", fallbackText: "" });
        expect(canRetract()).toBe(true);
        void emit()({ type: "tool-started", source: TOP, toolUseId: "t1", name: "read_file", input: {} });
        expect(canRetract()).toBe(false);
        release();
        await sendP;
    });

    test("flips false the instant a card part lands", async () => {
        const { sendP, emit, release } = startBusyTurn({ kind: "ok", fallbackText: "" });
        expect(canRetract()).toBe(true);
        void emit()({ type: "data-plan", source: TOP, data: { planId: "p1", title: "t", steps: [] } });
        expect(canRetract()).toBe(false);
        release();
        await sendP;
    });
});

describe("retract during the no-output window", () => {
    test("a clean retract splices, removes the thread orphan, and seeds the composer", async () => {
        // The nominal no-output retract: a busy turn that produced nothing is taken back before any output.
        // The live store is spliced back to empty (no user/assistant remnants), the durable tail removal
        // runs exactly once and SUCCEEDS, the composer is re-seeded with the original text, and the chat
        // returns to idle — raising no notice of its own (only the downgrade/fault paths notify). The
        // notice singleton is not cleared between cases, so we assert the retract left whatever was showing
        // untouched rather than asserting an absolute null a prior case could have populated.
        const noticeBefore = currentNotice();
        const { sendP, release } = startBusyTurn({ kind: "aborted" });
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        let durableCalls = 0;
        const retractSeams: RetractSeams = {
            runtime: () => stubRuntime,
            retractTurn: () => {
                durableCalls++;
                return okAsync({ kind: "retracted" as const, messages: 2 });
            },
        };
        const retractP = retract(seed.set, retractSeams);
        release();
        await retractP;
        await sendP;

        expect(messages.length).toBe(0);
        expect(durableCalls).toBe(1);
        expect(seed.get()).toBe("original text");
        expect(chatStatus()).toBe("idle");
        expect(currentNotice()).toBe(noticeBefore);
    });

    test("a delta racing the abort settlement downgrades to a plain interrupt", async () => {
        // The engine aborts, but a delta lands AFTER the retract fired the abort and BEFORE the turn
        // settles — so the re-validation sees produced output and keeps the message.
        const { sendP, emit, release } = startBusyTurn({ kind: "aborted" });
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        let durableCalls = 0;
        const retractSeams: RetractSeams = {
            runtime: () => stubRuntime,
            retractTurn: () => {
                durableCalls++;
                return okAsync({ kind: "retracted" as const, messages: 2 });
            },
        };
        const retractP = retract(seed.set, retractSeams);
        // retract has claimed the token and fired the abort; it is now awaiting settlement. Race output in.
        void emit()({ type: "text-delta", text: "racing output" });
        release();
        await retractP;
        await sendP;

        // Downgrade: message kept, nothing spliced, no durable removal, composer NOT seeded.
        expect(messages.length).toBe(2);
        expect(messages[0]?.role).toBe("user");
        expect(messages[1]?.role).toBe("assistant");
        expect(durableCalls).toBe(0);
        expect(seed.get()).toBeNull();
        expect(chatStatus()).toBe("idle");
        // The kept turn carries its streamed text and the interrupted marker (the plain-interrupt settle).
        const answer = messages[1]?.parts.find((p) => p.type === "text");
        expect(answer?.type === "text" ? answer.text : undefined).toBe("racing output");
        expect(messages[1]?.interrupted).toBe(true);
        // A notice explains the downgrade.
        expect(currentNotice()?.kind).toBe("info");
        expect(currentNotice()?.text).toContain("Kept your message");
    });

    test("an append fault skips the durable retract but still splices and seeds", async () => {
        // The aborted turn's appendTurn faulted, so the thread's tail is an EARLIER turn — the durable
        // removal must be skipped, while the live store is still spliced and the composer seeded.
        const appendError: DbError = { type: "mutation_failed", op: "appendTurn", cause: "boom" };
        const { sendP, release } = startBusyTurn({ kind: "aborted", appendError });
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        let durableCalls = 0;
        const retractSeams: RetractSeams = {
            runtime: () => stubRuntime,
            retractTurn: () => {
                durableCalls++;
                return okAsync({ kind: "retracted" as const, messages: 1 });
            },
        };
        const retractP = retract(seed.set, retractSeams);
        release();
        await retractP;
        await sendP;

        expect(messages.length).toBe(0);
        expect(durableCalls).toBe(0);
        expect(seed.get()).toBe("original text");
        expect(chatStatus()).toBe("idle");
    });

    test("a swap mid-retract drops the store writes and seed but still removes the thread orphan", async () => {
        // The durable removal is committed at the keypress and thread-scoped, so a session swap that
        // supersedes the retract while the removal is in flight still lets it complete — while every
        // remaining UI write (the composer seed) is dropped, and the cleared store stays cleared.
        const { sendP, release } = startBusyTurn({ kind: "aborted" });
        expect(canRetract()).toBe(true);

        let releaseDurable!: () => void;
        const durableGate = new Promise<void>((r) => {
            releaseDurable = r;
        });
        let durableCalledResolve!: () => void;
        const durableCalled = new Promise<void>((r) => {
            durableCalledResolve = r;
        });
        let durableCalls = 0;
        const seed = seedCell();
        const retractSeams: RetractSeams = {
            runtime: () => stubRuntime,
            retractTurn: () => {
                durableCalls++;
                durableCalledResolve();
                return ResultAsync.fromSafePromise(durableGate.then(() => ({ kind: "retracted" as const, messages: 1 })));
            },
        };
        const retractP = retract(seed.set, retractSeams);
        release(); // the engine settles → retract splices the store, then parks in the durable removal
        await durableCalled; // retract is now awaiting the durable retract
        resetHotState(); // the swap supersedes the retract's remaining writes
        releaseDurable();
        await retractP;
        await sendP;

        expect(durableCalls).toBe(1); // the durable removal ran against the old thread
        expect(seed.get()).toBeNull(); // the composer seed was dropped by the swap
        expect(messages.length).toBe(0); // the cleared store stays cleared
        expect(chatStatus()).toBe("idle");
    });

    test("a durable fault seeds the composer + notifies, and the next send heals it once before proceeding", async () => {
        // A dedicated thread id so the pending-retract flag this leaves is consumed by THIS test's heal
        // send — nothing leaks into another case (resetHotState deliberately does not clear it).
        const THREAD = "retract-heal-thread";
        const dbErr: DbError = { type: "mutation_failed", op: "retractLastTurn", cause: "transient" };

        // Phase 1: the durable retract faults.
        const { sendP, release } = startBusyTurn({ kind: "aborted" }, THREAD);
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        const retractSeams: RetractSeams = {
            runtime: () => stubRuntime,
            retractTurn: () => errAsync(dbErr),
        };
        const retractP = retract(seed.set, retractSeams);
        release();
        await retractP;
        await sendP;

        // The store is spliced, the composer holds the original text, and an error notice surfaced.
        expect(messages.length).toBe(0);
        expect(seed.get()).toBe("original text");
        expect(currentNotice()?.kind).toBe("error");
        expect(currentNotice()?.text).toContain("Could not retract");

        // Phase 2: the next send on that thread retries the removal once, then proceeds despite a 2nd fault.
        let healCalls = 0;
        const healSeams: SendSeams = {
            runtime: () => stubRuntime,
            runChatTurn: async (): Promise<TurnOutcome> => ({ kind: "ok", fallbackText: "answer" }),
            retractTurn: (_pool, threadId) => {
                healCalls++;
                expect(threadId).toBe(THREAD);
                return errAsync(dbErr);
            },
        };
        await send({ sessionId: THREAD, analysisId: AID, userText: "again" }, healSeams);

        expect(healCalls).toBe(1); // retried exactly once before appending
        expect(messages.length).toBe(2); // the send proceeded despite the second fault
        expect(messages[0]?.role).toBe("user");
        expect(chatStatus()).toBe("idle");
    });

    test("a stray retract call outside the window is a safe no-op", async () => {
        // No turn is in flight, so the gate re-check inside retract returns early: nothing is seeded and
        // no durable removal is attempted.
        const seed = seedCell();
        let durableCalls = 0;
        await retract(seed.set, {
            runtime: () => stubRuntime,
            retractTurn: () => {
                durableCalls++;
                return okAsync({ kind: "retracted" as const, messages: 1 });
            },
        });
        expect(seed.get()).toBeNull();
        expect(durableCalls).toBe(0);
    });
});

describe("the interrupt arm window", () => {
    // The production 5-second lapse (INTERRUPT_ARM_WINDOW_MS) is never waited out — a real >5s wait would
    // exceed bun's default per-test timeout. The expiry PATH is exercised instead through armInterrupt's
    // window override (a 1ms window), and the other window-close paths — a turn ending, the abort firing,
    // and a session swap — are covered directly below.
    test("armInterrupt arms the window; a re-arm keeps it armed", () => {
        expect(interruptArmed()).toBe(false);
        armInterrupt();
        expect(interruptArmed()).toBe(true);
        armInterrupt(); // a fresh press refreshes the window
        expect(interruptArmed()).toBe(true);
    });

    test("the armed window lapses to disarmed when its timer elapses", async () => {
        armInterrupt(1); // a 1ms window (the override) instead of the 5s production default
        expect(interruptArmed()).toBe(true);
        await new Promise((r) => setTimeout(r, 10));
        // The `.unref`'d timer still fires while the loop is alive, flipping the window closed on its own.
        expect(interruptArmed()).toBe(false);
    });

    test("resetHotState disarms an armed window", () => {
        armInterrupt();
        expect(interruptArmed()).toBe(true);
        resetHotState();
        expect(interruptArmed()).toBe(false);
    });

    test("a turn ending disarms a window armed mid-turn", async () => {
        const { sendP, release } = startBusyTurn({ kind: "ok", fallbackText: "done" });
        armInterrupt();
        expect(interruptArmed()).toBe(true);
        release();
        await sendP;
        // finishTurn disarms, so the armed window never carries into idle or the next turn.
        expect(interruptArmed()).toBe(false);
    });

    test("firing the abort disarms the armed window immediately", async () => {
        // The second interrupt press fires `abort`, and there is nothing left to interrupt — so the window
        // disarms on the abort path itself, not only later when the engine's unwind reaches finishTurn.
        const { sendP, release } = startBusyTurn({ kind: "aborted" });
        armInterrupt();
        expect(interruptArmed()).toBe(true);
        abort();
        expect(interruptArmed()).toBe(false);
        release();
        await sendP;
    });
});

describe("the interrupted marker on an aborted turn", () => {
    test("a turn that streamed output keeps its assistant message with the muted marker", async () => {
        const seams = fakeSeams({ kind: "aborted" }, (emit) => {
            void emit({ type: "text-delta", text: "partial answer" });
        });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);

        expect(messages.length).toBe(2);
        expect(messages[1]?.role).toBe("assistant");
        expect(messages[1]?.interrupted).toBe(true);
        const part = messages[1]?.parts.find((p) => p.type === "text");
        expect(part?.type === "text" ? part.text : undefined).toBe("partial answer");
        // Interruption is a user action, not a failure — idle, no error banner.
        expect(chatStatus()).toBe("idle");
        expect(errorMsg()).toBeNull();
    });

    test("a turn that produced nothing leaves only the user message and no marker", async () => {
        const seams = fakeSeams({ kind: "aborted" });
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, seams);

        expect(messages.length).toBe(1);
        expect(messages[0]?.role).toBe("user");
        expect(messages.some((m) => m.interrupted)).toBe(false);
        expect(chatStatus()).toBe("idle");
    });
});

// The retract is a first-class store writer (it claims the generation token), so it must supersede a
// transcript load the same way `send` does — mirrors the load-vs-turn interleaving in conversation.test.ts.
describe("a transcript load resolving mid-retract", () => {
    const emptyPage = (total: number): MessagePage => ({ messages: [], total, page: 0, perPage: 200, hasMore: false });
    // A stale reload the dropped load WOULD have mounted — present so a failure to drop would be visible as
    // a resurrected message rather than merely an empty store that happened to stay empty.
    const staleCortex = (): CortexMsg[] => [{ id: "stale", role: "assistant", parts: [{ type: "text", text: "stale-transcript" }] }] as unknown as CortexMsg[];

    test("a load parked mid-retract drops and never resurrects the spliced-away turn", async () => {
        // A transcript load parks at its page read while a retract runs to completion. The retract claims a
        // newer store-write token, so when the parked load finally resolves it detects the newer generation
        // and drops — the spliced-empty store is never repopulated with the history the load would mount.
        let releaseLoad!: () => void;
        const loadGate = new Promise<void>((r) => {
            releaseLoad = r;
        });
        const loadSeams: LoadSeams = {
            runtime: () => stubRuntime,
            loadPage: () => ResultAsync.fromSafePromise(loadGate.then(() => emptyPage(1))),
            toCortex: async () => staleCortex(),
        };
        const load = loadMessages(SID, AID, loadSeams); // parks at its page read

        const { sendP, release } = startBusyTurn({ kind: "aborted" });
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        const retractSeams: RetractSeams = {
            runtime: () => stubRuntime,
            retractTurn: () => okAsync({ kind: "retracted" as const, messages: 2 }),
        };
        const retractP = retract(seed.set, retractSeams);
        release();
        await retractP;
        await sendP;

        // The retract spliced the turn away — the store is empty and the composer holds the original text.
        expect(messages.length).toBe(0);
        expect(seed.get()).toBe("original text");

        releaseLoad();
        await load;

        // The parked load was superseded by the retract's token and dropped: nothing resurrected.
        expect(messages.length).toBe(0);
        expect(chatStatus()).toBe("idle");
    });
});
