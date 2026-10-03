import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import { toChatFrame, type ChatFrame, type ChatMessage } from "@inflexa-ai/harness/contracts/index.js";

import type { MessageList, RetractResponse, TurnSummary } from "../../api/conversation.ts";
import type { ClientError } from "../../client/api.ts";
import type { ChatTurnStream } from "../../client/conversation.ts";
import {
    abort,
    armInterrupt,
    canRetract,
    errorMsg,
    interruptArmed,
    loadMessages,
    type LoadOpts,
    messages,
    promptHistory,
    resetHotState,
    retract,
    type RetractOpts,
    send,
    type SendOpts,
} from "./conversation.ts";
import { chatStatus } from "./status.ts";
import { __resetNoticesForTest, currentNotice } from "./notice.ts";

// The conversation state is a module singleton (one chat screen at a time), so reset it between
// cases. `pendingRetract` is the ONE piece resetHotState does not clear (an orphan is thread-scoped,
// not session-scoped), so the durable-fault case below uses its own thread id and lets the heal send
// consume the pending entry — leaving nothing behind for a later case to trip over.
//
// The local server is a fake whose turn streams the frames that the chat route sends; the cases drive
// it with loop events, which the fake translates with `toChatFrame`, as the route does.
const SID = "s1";
const AID = "a1";
const TOP = { agentId: "tui-chat", callPath: ["tui-chat"] };
// The source that the chat route gives a text delta of the root provider, and its terminal frame.
const ROUTE_SOURCE = { agentId: "chat", callPath: ["chat"] };

/** One event that the agent loop emits, which the chat route turns into a frame. */
type LoopEvent = Parameters<typeof toChatFrame>[0];

/** Send the frame of one loop event to the hook. It resolves after the hook applied the frame. */
type Emit = (event: LoopEvent) => Promise<void>;

/** What a turn of the fake server ends with: the fields of the summary that `GET {T}/turns/:turnId` gives. */
type End = Pick<TurnSummary, "status"> & Partial<Pick<TurnSummary, "opened" | "turnUsage" | "fallbackText" | "storeFailed" | "failure">>;

const ABORTED: End = { status: "aborted", opened: true };

/** A refusal or a transport fault, as the client gives it. */
const SERVER_FAULT: ClientError = { type: "http", status: 500, body: { error: "internal_error", message: "The server failed to handle the request." } };

/**
 * The frame stream of one turn. Each frame is serialized and parsed again, as the wire does. A frame
 * resolves its `send` when the reader asks for the next one, which is after the hook applied it.
 */
function frameChannel(): { send: (frame: ChatFrame) => Promise<void>; close: () => void; frames: AsyncGenerator<Result<ChatFrame, ClientError>> } {
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
                // eslint-disable-next-line neverthrow/must-use-result -- a yielded Result is consumed by the `for await` of the hook, which the rule cannot follow
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
                // The parse gives back the frame that went in: it is JSON by the wire contract.
                waiting.push({ frame: JSON.parse(JSON.stringify(frame)) as ChatFrame, applied });
                notify();
            }),
        close: () => {
            closed = true;
            notify();
        },
        frames: frames(),
    };
}

/** A fake of the local server, with each abort that the hook sent it. */
type FakeServer = SendOpts & { readonly aborted: string[] };

/** A server whose turn streams what `drive` emits, then the terminal frame of `end`, and whose summary is `end`. */
function fakeServer(end: End, drive: (emit: Emit) => void | Promise<void> = () => {}): FakeServer {
    const aborted: string[] = [];
    return {
        aborted,
        startTurn: () => {
            const channel = frameChannel();
            const emit: Emit = (event) => {
                const frame = toChatFrame(event, ROUTE_SOURCE);
                return frame === null ? Promise.resolve() : channel.send(frame);
            };
            void (async () => {
                await drive(emit);
                await channel.send(
                    end.status === "failed"
                        ? { type: "error", message: end.failure?.message ?? "The turn failed.", source: ROUTE_SOURCE }
                        : { type: "finish", source: ROUTE_SOURCE },
                );
                channel.close();
            })();
            return okAsync({ turnId: "turn-1", frames: channel.frames });
        },
        abortTurn: (_analysisId, _threadId, turnId) => {
            aborted.push(turnId);
            return okAsync({ turnId, outcome: "aborting" });
        },
        fetchTurn: (analysisId, threadId, turnId) => okAsync({ turnId, threadId, analysisId, startedAt: "2026-10-02T00:00:00.000Z", ...end }),
        reloadTranscript: async () => undefined,
        healRetract: () => okAsync({ kind: "retracted", messages: 0 }),
    };
}

/** A transcript as `GET {T}/messages` gives it. */
function messageList(list: ChatMessage[]): MessageList {
    return { messages: list, total: list.length, page: 0, perPage: list.length, hasMore: false };
}

/**
 * A capture cell for the composer seed, read through `.get()` so control flow never narrows it back to
 * its null initializer — the `seedComposer` closure assigns it out of band.
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

/** A retract of the server that gives `outcome`, and keeps the `ifOrphan` of each call. */
function recordingRetract(outcome: () => ResultAsync<RetractResponse, ClientError> = () => okAsync({ kind: "retracted", messages: 2 })): RetractOpts & {
    readonly calls: boolean[];
} {
    const calls: boolean[] = [];
    return {
        calls,
        retractTurn: (_analysisId, _threadId, ifOrphan) => {
            calls.push(ifOrphan);
            return outcome();
        },
    };
}

/** A turn parked mid-flight: the server holds the stream at a gate so the retract/interrupt window can be probed. */
type ParkedTurn = {
    readonly sendP: Promise<void>;
    /** The emit of the parked turn — races output into the live turn. */
    readonly emit: Emit;
    /** Release the parked stream so it sends its terminal frame and the turn settles. */
    readonly release: () => void;
    readonly server: FakeServer;
};

/**
 * Start a turn and leave its stream parked at a gate BEFORE it ends. `send` runs synchronously up to its
 * first await, so by the time this returns the module hot state (assistant id, abort controller,
 * `turnSettled`, busy status, the empty assistant shell) is fully armed for a retract/interrupt probe.
 */
function startBusyTurn(end: End, sessionId = SID, analysisId = AID): ParkedTurn {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
    });
    let parkedEmit!: Emit;
    const server = fakeServer(end, async (emit) => {
        parkedEmit = emit;
        await gate;
    });
    const sendP = send({ sessionId, analysisId, userText: "original text" }, server);
    return { sendP, emit: (event) => parkedEmit(event), release, server };
}

// The notice channel is a module singleton too, and it QUEUES rather than replacing — so a notice a
// previous case left showing would sit in front of the one under test. Drained alongside the hot state.
beforeEach(() => {
    resetHotState();
    __resetNoticesForTest();
});
afterEach(() => {
    resetHotState();
    __resetNoticesForTest();
});

describe("canRetract gates the retract window", () => {
    test("false before any turn, true during a busy no-output turn", async () => {
        expect(canRetract()).toBe(false);
        const { sendP, release } = startBusyTurn({ status: "done", opened: true });
        expect(canRetract()).toBe(true);
        release();
        await sendP;
        // Back to idle → the window is closed again.
        expect(canRetract()).toBe(false);
    });

    test("flips false the instant a text delta lands", async () => {
        const { sendP, emit, release } = startBusyTurn({ status: "done", opened: true });
        expect(canRetract()).toBe(true);
        await emit({ type: "text-delta", text: "answering" });
        expect(canRetract()).toBe(false);
        release();
        await sendP;
    });

    test("flips false the instant a tool part starts", async () => {
        const { sendP, emit, release } = startBusyTurn({ status: "done", opened: true });
        expect(canRetract()).toBe(true);
        await emit({ type: "tool-started", source: TOP, toolUseId: "t1", name: "read_file", input: {} });
        expect(canRetract()).toBe(false);
        release();
        await sendP;
    });

    test("flips false the instant a card part lands", async () => {
        const { sendP, emit, release } = startBusyTurn({ status: "done", opened: true });
        expect(canRetract()).toBe(true);
        await emit({ type: "data-plan", source: TOP, data: { id: "p1", planId: "pln-00000001", title: "t", steps: [] } });
        expect(canRetract()).toBe(false);
        release();
        await sendP;
    });
});

describe("the abort reaches the server by the turn id", () => {
    test("an abort during the turn sends the abort of the server for that turn", async () => {
        const { sendP, emit, release, server } = startBusyTurn(ABORTED);
        // A frame that the hook applied proves that it reads the stream, thus it knows the turn id.
        await emit({ type: "text-delta", text: "partial" });
        abort();
        release();
        await sendP;
        expect(server.aborted).toEqual(["turn-1"]);
        expect(messages[1]?.interrupted).toBe(true);
        expect(chatStatus()).toBe("idle");
    });

    test("an abort before the server named the turn is sent once the id arrives", async () => {
        let open!: () => void;
        const opened = new Promise<void>((r) => {
            open = r;
        });
        const server = fakeServer(ABORTED);
        // The open of the turn waits, thus the abort below comes before the hook knows the turn id.
        const slowServer: SendOpts = {
            ...server,
            startTurn: (analysisId, threadId, message) => ResultAsync.fromSafePromise(opened).andThen(() => server.startTurn(analysisId, threadId, message)),
        };
        const sendP = send({ sessionId: SID, analysisId: AID, userText: "original text" }, slowServer);
        abort();
        expect(server.aborted).toEqual([]);
        open();
        await sendP;
        expect(server.aborted).toEqual(["turn-1"]);
    });
});

describe("retract during the no-output window", () => {
    test("a clean retract splices, removes the thread orphan, and seeds the composer", async () => {
        // The nominal no-output retract: a busy turn that produced nothing is taken back before any output.
        // The live store is spliced back to empty (no user/assistant remnants), the durable tail removal
        // runs exactly once and SUCCEEDS, the composer is re-seeded with the original text, and the chat
        // returns to idle — raising no notice of its own (only the downgrade/fault paths notify).
        const noticeBefore = currentNotice();
        const { sendP, release, server } = startBusyTurn(ABORTED);
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        const retractOpts = recordingRetract();
        const retractP = retract(seed.set, retractOpts);
        release();
        await retractP;
        await sendP;

        expect(messages.length).toBe(0);
        // The summary says the opening landed, thus the plain retract runs, not the guarded one.
        expect(retractOpts.calls).toEqual([false]);
        expect(seed.get()).toBe("original text");
        expect(chatStatus()).toBe("idle");
        expect(currentNotice()).toBe(noticeBefore);
        // The retract stopped the turn through the abort of the server.
        expect(server.aborted).toEqual(["turn-1"]);
    });

    test("a retracted prompt leaves no history entry behind", async () => {
        // Prompt-history recall derives its entries from this same store, so an unsent message must not be
        // recallable: retract means UNSEND, and the text is handed back to the composer anyway. Nothing in
        // `promptHistory` filters retracts — this holds only because the splice below is a real removal.
        const { sendP, release } = startBusyTurn(ABORTED);
        expect(promptHistory()).toEqual(["original text"]);

        const retractP = retract(seedCell().set, recordingRetract());
        release();
        await retractP;
        await sendP;

        expect(promptHistory()).toEqual([]);
    });

    test("the visible transition lands as one step, after the durable removal — never split across it", async () => {
        // Ordering, not just outcome. The transcript losing the message, the text coming back, and the
        // return to idle are one perceptual event; a server round-trip between any two of them leaves the
        // user looking at a half-applied state (message gone, composer empty, still spinning) with no clue
        // which way it will resolve. Park the durable removal and assert NOTHING visible has moved yet.
        const { sendP, release } = startBusyTurn(ABORTED);
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        let releaseDurable!: () => void;
        const durableGate = new Promise<void>((r) => {
            releaseDurable = r;
        });
        let durableReached!: () => void;
        const durableWasReached = new Promise<void>((r) => {
            durableReached = r;
        });
        const retractOpts = recordingRetract(() => {
            durableReached();
            return ResultAsync.fromSafePromise(durableGate.then((): RetractResponse => ({ kind: "retracted", messages: 1 })));
        });
        const retractP = retract(seed.set, retractOpts);
        release();
        await durableWasReached;

        // Mid-removal: the message is still on screen, the composer untouched, the turn still busy.
        expect(messages.length).toBe(2);
        expect(seed.get()).toBeNull();
        expect(chatStatus()).toBe("busy");

        releaseDurable();
        await retractP;
        await sendP;

        // And then all three move together.
        expect(messages.length).toBe(0);
        expect(seed.get()).toBe("original text");
        expect(chatStatus()).toBe("idle");
    });

    test("a delta racing the abort settlement downgrades to a plain interrupt", async () => {
        // The server aborts, but a delta lands AFTER the retract fired the abort and BEFORE the turn
        // settles — so the re-validation sees produced output and keeps the message.
        const { sendP, emit, release } = startBusyTurn(ABORTED);
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        const retractOpts = recordingRetract();
        const retractP = retract(seed.set, retractOpts);
        // retract has claimed the token and fired the abort; it is now awaiting settlement. Race output in.
        void emit({ type: "text-delta", text: "racing output" });
        release();
        await retractP;
        await sendP;

        // Downgrade: message kept, nothing spliced, no durable removal, composer NOT seeded.
        expect(messages.length).toBe(2);
        expect(messages[0]?.role).toBe("user");
        expect(messages[1]?.role).toBe("assistant");
        expect(retractOpts.calls).toEqual([]);
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

    test("an opening that did not land skips the durable retract but still splices and seeds", async () => {
        // The tail of the thread is an EARLIER turn, thus the durable removal must be skipped.
        const { sendP, release } = startBusyTurn({ status: "aborted", opened: false, storeFailed: true });
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        const retractOpts = recordingRetract();
        const retractP = retract(seed.set, retractOpts);
        release();
        await retractP;
        await sendP;

        expect(messages.length).toBe(0);
        expect(retractOpts.calls).toEqual([]);
        expect(seed.get()).toBe("original text");
        expect(chatStatus()).toBe("idle");
    });

    test("a fault after the opening keeps the durable retract", async () => {
        const { sendP, release } = startBusyTurn({ status: "aborted", opened: true, storeFailed: true });
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        const retractOpts = recordingRetract(() => okAsync({ kind: "retracted", messages: 3 }));
        const retractP = retract(seed.set, retractOpts);
        release();
        await retractP;
        await sendP;

        expect(messages.length).toBe(0);
        expect(retractOpts.calls).toEqual([false]);
        expect(seed.get()).toBe("original text");
    });

    test("a swap mid-retract drops the store writes and seed but still removes the thread orphan", async () => {
        // The durable removal is committed at the keypress and thread-scoped, so a session swap that
        // supersedes the retract while the removal is in flight still lets it complete — while every
        // remaining UI write (the composer seed) is dropped, and the cleared store stays cleared.
        const { sendP, release } = startBusyTurn(ABORTED);
        expect(canRetract()).toBe(true);

        let releaseDurable!: () => void;
        const durableGate = new Promise<void>((r) => {
            releaseDurable = r;
        });
        let durableCalledResolve!: () => void;
        const durableCalled = new Promise<void>((r) => {
            durableCalledResolve = r;
        });
        const seed = seedCell();
        const retractOpts = recordingRetract(() => {
            durableCalledResolve();
            return ResultAsync.fromSafePromise(durableGate.then((): RetractResponse => ({ kind: "retracted", messages: 1 })));
        });
        const retractP = retract(seed.set, retractOpts);
        release(); // the stream ends → retract parks in the durable removal
        await durableCalled; // retract is now awaiting the durable retract
        resetHotState(); // the swap supersedes the retract's remaining writes
        releaseDurable();
        await retractP;
        await sendP;

        expect(retractOpts.calls).toEqual([false]); // the durable removal ran against the old thread
        expect(seed.get()).toBeNull(); // the composer seed was dropped by the swap
        expect(messages.length).toBe(0); // the cleared store stays cleared
        expect(chatStatus()).toBe("idle");
    });

    test("a durable fault seeds the composer + notifies, and the next send heals it once before proceeding", async () => {
        // A dedicated thread id so the pending-retract flag this leaves is consumed by THIS test's heal
        // send — nothing leaks into another case (resetHotState deliberately does not clear it).
        const THREAD = "retract-heal-thread";

        // Phase 1: the durable retract faults.
        const { sendP, release } = startBusyTurn(ABORTED, THREAD);
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        const retractP = retract(
            seed.set,
            recordingRetract(() => errAsync(SERVER_FAULT)),
        );
        release();
        await retractP;
        await sendP;

        // The store is spliced, the composer holds the original text, and an error notice surfaced.
        expect(messages.length).toBe(0);
        expect(seed.get()).toBe("original text");
        expect(currentNotice()?.kind).toBe("error");
        expect(currentNotice()?.text).toContain("Could not retract");

        // Phase 2: the next send on that thread retries the removal once, then proceeds despite a 2nd fault.
        const healed: { analysisId: string; threadId: string }[] = [];
        const healServer: SendOpts = {
            ...fakeServer({ status: "done", opened: true, fallbackText: "answer" }),
            healRetract: (analysisId, threadId) => {
                healed.push({ analysisId, threadId });
                return errAsync(SERVER_FAULT);
            },
        };
        await send({ sessionId: THREAD, analysisId: AID, userText: "again" }, healServer);

        expect(healed).toEqual([{ analysisId: AID, threadId: THREAD }]); // retried exactly once before appending
        expect(messages.length).toBe(2); // the send proceeded despite the second fault
        expect(messages[0]?.role).toBe("user");
        expect(chatStatus()).toBe("idle");
    });

    test("a session swap while the pending-retract heal is parked drops the send with no store write", async () => {
        // The send claims its store-write token BEFORE the heal await, so a session swap that lands while
        // the heal is parked supersedes it: on the heal resolving, the send sees the newer token and bails
        // with no user message pushed and the status never leaving idle. Without that re-check the send
        // would claim a NEWER token below and push the swapped-away session's message into the cleared,
        // swapped-in store.
        const THREAD = "retract-swap-heal-thread";

        // Phase 1: a durable retract faults, leaving the pending-heal flag on THREAD (as in the case above).
        const { sendP: faultSendP, release: faultRelease } = startBusyTurn(ABORTED, THREAD);
        expect(canRetract()).toBe(true);
        const retractP = retract(
            seedCell().set,
            recordingRetract(() => errAsync(SERVER_FAULT)),
        );
        faultRelease();
        await retractP;
        await faultSendP;
        expect(messages.length).toBe(0);

        // Phase 2: the next send parks in the heal retry; a swap supersedes it before it can append.
        let releaseHeal!: () => void;
        const healGate = new Promise<void>((r) => {
            releaseHeal = r;
        });
        let healReached!: () => void;
        const healWasReached = new Promise<void>((r) => {
            healReached = r;
        });
        const healServer: SendOpts = {
            ...fakeServer({ status: "done", opened: true, fallbackText: "answer" }),
            healRetract: () => {
                healReached();
                return ResultAsync.fromSafePromise(healGate.then((): RetractResponse => ({ kind: "retracted", messages: 1 })));
            },
        };
        const sendP = send({ sessionId: THREAD, analysisId: AID, userText: "swapped away" }, healServer);
        await healWasReached; // the send is parked in the heal await, its token already claimed
        resetHotState(); // the swap claims a newer store-write token and clears the store
        releaseHeal();
        await sendP; // resolves without error despite the supersession

        expect(messages.length).toBe(0); // no user message landed in the swapped-in store
        expect(chatStatus()).toBe("idle"); // the send bailed before its busy transition
    });

    test("a stray retract call outside the window is a safe no-op", async () => {
        // No turn is in flight, so the gate re-check inside retract returns early: nothing is seeded and
        // no durable removal is attempted.
        const seed = seedCell();
        const retractOpts = recordingRetract();
        await retract(seed.set, retractOpts);
        expect(seed.get()).toBeNull();
        expect(retractOpts.calls).toEqual([]);
    });

    test("a second retract during settlement is a no-op — the removal runs once", async () => {
        // Two up-arrows land inside the settlement window: the first claims the in-flight guard and runs the
        // whole sequence; the second (and a third after both settle) see the guard folded into `canRetract`
        // and bail. The durable removal is deliberately un-token-gated (a swap must not cancel it), so
        // without the guard the second retract would reach it too — deleting the thread's NEW, already-
        // answered tail after the first press removed the orphan. The guard, not the token, keeps it once-only.
        const { sendP, release } = startBusyTurn(ABORTED);
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        let seedCalls = 0;
        const countingSeed = (text: string): void => {
            seedCalls++;
            seed.set(text);
        };
        const retractOpts = recordingRetract();

        // Fire two retracts WITHOUT awaiting the first: it parks awaiting settlement, so the second sees the
        // guard already set and returns immediately.
        const first = retract(countingSeed, retractOpts);
        const second = retract(countingSeed, retractOpts);
        // The window is closed the instant the first retract claimed the guard.
        expect(canRetract()).toBe(false);
        release();
        await Promise.all([first, second]);
        await sendP;

        // A third press after both settle is likewise inert (idle, no assistant in flight).
        let thirdSeed: string | null = "unset";
        await retract((text) => (thirdSeed = text), retractOpts);

        expect(retractOpts.calls).toEqual([false]); // the durable removal ran exactly once
        expect(messages.length).toBe(0); // spliced exactly once, back to empty
        expect(seedCalls).toBe(1); // the composer was seeded exactly once
        expect(seed.get()).toBe("original text");
        expect(thirdSeed).toBe("unset"); // the third retract never seeded
        expect(canRetract()).toBe(false); // the window stays closed
    });
});

describe("a rejecting transport still settles the turn", () => {
    test("send completes as a lost turn rather than hanging busy", async () => {
        // The driver of the turn is non-rejecting by contract, but if the transport EVER rejects, `send` must
        // still settle: it catches the throw and routes it through the lost-stream handling — so the status
        // leaves "busy" for the failure banner rather than wedging there, and `send` itself resolves without
        // an unhandled rejection.
        const server: SendOpts = {
            ...fakeServer(ABORTED),
            startTurn: () => new ResultAsync<ChatTurnStream, ClientError>(Promise.reject(new Error("transport exploded"))),
        };
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

        expect(chatStatus()).toBe("error");
        expect(errorMsg()).toContain("transport exploded");
    });

    test("a retract awaiting a rejecting transport resolves, and removes the tail only if it is an orphan", async () => {
        // A retract parks on the turn's settlement promise. If the transport rejects, WITHOUT the
        // settle-on-throw guard `settleTurn` would never fire and this retract would await forever. With
        // it, the promise settles as lost and the retract completes (a hang here fails the test by timeout).
        let reject!: (e: unknown) => void;
        const gate = new Promise<Result<ChatTurnStream, ClientError>>((_resolve, rej) => {
            reject = rej;
        });
        const server: SendOpts = { ...fakeServer(ABORTED), startTurn: () => new ResultAsync(gate) };
        const sendP = send({ sessionId: SID, analysisId: AID, userText: "original text" }, server);
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        const retractOpts = recordingRetract();
        const retractP = retract(seed.set, retractOpts);
        // The retract has claimed the token, fired the abort, and now awaits settlement. Reject the transport.
        reject(new Error("transport exploded mid-turn"));
        await retractP;
        await sendP;

        expect(chatStatus()).not.toBe("busy");
        // A rejection gives no sign whether the opening landed, thus only the guarded removal runs: it
        // removes the tail only while that tail has no assistant row.
        expect(retractOpts.calls).toEqual([true]);
        expect(seed.get()).toBe("original text");
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
        const { sendP, release } = startBusyTurn({ status: "done", opened: true, fallbackText: "done" });
        armInterrupt();
        expect(interruptArmed()).toBe(true);
        release();
        await sendP;
        // finishTurn disarms, so the armed window never carries into idle or the next turn.
        expect(interruptArmed()).toBe(false);
    });

    test("firing the abort disarms the armed window immediately", async () => {
        // The second interrupt press fires `abort`, and there is nothing left to interrupt — so the window
        // disarms on the abort path itself, not only later when the turn's unwind reaches finishTurn.
        const { sendP, release } = startBusyTurn(ABORTED);
        armInterrupt();
        expect(interruptArmed()).toBe(true);
        abort();
        expect(interruptArmed()).toBe(false);
        release();
        await sendP;
    });

    test("a re-arm after the abort fired stays disarmed while the turn dies", async () => {
        // The turn stays "busy" until settlement, so the interrupt layer stays enabled and a third esc
        // press calls armInterrupt again. With the abort already fired there is nothing left to interrupt,
        // so the re-arm is a no-op — the hint never flips back to armed while the turn is unwinding.
        const { sendP, release } = startBusyTurn(ABORTED);
        armInterrupt();
        abort();
        expect(interruptArmed()).toBe(false);
        armInterrupt(); // a third esc press during the abort unwind
        expect(interruptArmed()).toBe(false);
        release();
        await sendP;
    });
});

describe("the interrupted marker on an aborted turn", () => {
    test("a turn that streamed output keeps its assistant message with the muted marker", async () => {
        const server = fakeServer(ABORTED, (emit) => void emit({ type: "text-delta", text: "partial answer" }));
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, server);

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
        await send({ sessionId: SID, analysisId: AID, userText: "?" }, fakeServer(ABORTED));

        expect(messages.length).toBe(1);
        expect(messages[0]?.role).toBe("user");
        expect(messages.some((m) => m.interrupted)).toBe(false);
        expect(chatStatus()).toBe("idle");
    });
});

describe("the interrupted marker survives a transcript reload", () => {
    // A replayed transcript: a user turn, then the interrupted assistant turn carrying its partial — the
    // durable `interrupted` field is what the reload must carry onto the mounted message.
    const interruptedTranscript = (): ChatMessage[] => [
        { id: "u1", role: "user", parts: [{ type: "text", text: "?" }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "partial answer" }], interrupted: true },
    ];

    test("a loaded transcript flags the marked message and leaves the unmarked one clean", async () => {
        await loadMessages(AID, SID, { fetchMessages: () => okAsync(messageList(interruptedTranscript())) });

        expect(messages.length).toBe(2);
        // The user turn carries no marker; the interrupted assistant turn renders exactly what the live
        // abort showed — the muted marker, re-derived from the persisted field.
        expect(messages[0]?.role).toBe("user");
        expect(messages[0]?.interrupted).toBeUndefined();
        expect(messages[1]?.role).toBe("assistant");
        expect(messages[1]?.interrupted).toBe(true);
        const part = messages[1]?.parts.find((p) => p.type === "text");
        expect(part?.type === "text" ? part.text : undefined).toBe("partial answer");
    });

    test("a call cut off mid-flight replays as incomplete, never as a success or a failure", async () => {
        // The harness records what it observed — a dispatch and no completion — in the ONE field that
        // carries a call's terminal state. `incomplete` is not a success and not a failure, and the
        // renderer's mapping to `running` is total, so no reader has to infer anything from an absent
        // value. The message's interruption badge is what says it will never finish.
        const replay: ChatMessage[] = [
            {
                id: "a1",
                role: "assistant",
                interrupted: true,
                parts: [
                    { type: "tool-call", toolCallId: "t1", toolName: "read_file", outcome: "incomplete", detail: "scripts/run.py" },
                    { type: "tool-call", toolCallId: "t2", toolName: "grep", outcome: "denied" },
                ],
            },
        ];
        await loadMessages(AID, SID, { fetchMessages: () => okAsync(messageList(replay)) });

        const calls = messages[0]?.parts.filter((p) => p.type === "tool-call") ?? [];
        expect(calls.map((p) => (p.type === "tool-call" ? p.outcome : null))).toEqual(["incomplete", "denied"]);
        // The detail recorded live rides the stored projection — nothing re-derives it on reload.
        expect(calls[0]?.type === "tool-call" ? calls[0].detail : undefined).toBe("scripts/run.py");
        expect(messages[0]?.interrupted).toBe(true);
    });
});

// The retract is a first-class store writer (it claims the generation token), so it must supersede a
// transcript load the same way `send` does — mirrors the load-vs-turn interleaving in conversation.test.ts.
describe("a transcript load resolving mid-retract", () => {
    test("a load parked mid-retract drops and never resurrects the spliced-away turn", async () => {
        // A transcript load parks at its read while a retract runs to completion. The retract claims a
        // newer store-write token, so when the parked load finally resolves it detects the newer generation
        // and drops — the spliced-empty store is never repopulated with the history the load would mount.
        let releaseLoad!: () => void;
        const loadGate = new Promise<void>((r) => {
            releaseLoad = r;
        });
        // A stale transcript the dropped load WOULD have mounted — present so a failure to drop would be
        // visible as a resurrected message rather than merely an empty store that happened to stay empty.
        const staleLoad: LoadOpts = {
            fetchMessages: () =>
                ResultAsync.fromSafePromise(
                    loadGate.then(() => messageList([{ id: "stale", role: "assistant", parts: [{ type: "text", text: "stale-transcript" }] }])),
                ),
        };
        const load = loadMessages(AID, SID, staleLoad); // parks at its read

        const { sendP, release } = startBusyTurn(ABORTED);
        expect(canRetract()).toBe(true);

        const seed = seedCell();
        const retractP = retract(seed.set, recordingRetract());
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
