/**
 * Recv-loop contract tests — does not spin DBOS. `awaitExec`'s `recv`
 * argument is injected with a hand-written stub that returns canned
 * envelopes in order.
 */

import { describe, expect, test } from "bun:test";
import { awaitExec, awaitExecCallback, awaitExecPoll, ExecTimeoutError, HardCancelError } from "./await-exec.js";
import { signCallback, verifyCallback } from "./hmac.js";
import type { ExecEventMessage, ExecResult, SandboxRef } from "./types.js";

const EXEC_ID = "wf-1:step-a:fn-0";
const SECRET = "base64:" + Buffer.from("01234567890123456789012345678901").toString("base64");
const NOW_MS = 1_700_000_000_000;
const FRESHNESS = 300;
const DEADLINE = NOW_MS + 60_000;

const REF: SandboxRef = {
    sandboxId: "sb-1",
    host: "127.0.0.1",
    port: 8765,
    backend: "docker",
    callbackSecret: SECRET,
};

/** Runs the pull step inline — these tests never spin DBOS. */
const passthroughStep = <T>(fn: () => Promise<T>) => fn();

/** A sandbox that has never heard of this exec: every pull says "keep waiting". */
const noPullFetch: typeof fetch = async () => new Response("unknown execId", { status: 404 });

/** Injected into every legacy test so the recv loop's behaviour is unchanged by the pull path. */
const NO_PULL = { runStep: passthroughStep, fetch: noPullFetch } as const;

function envelope(payload: unknown, ts: number = Math.floor(NOW_MS / 1000)): ExecEventMessage {
    const bodyBytes = Buffer.from(JSON.stringify(payload), "utf8");
    const sig = signCallback({
        execId: EXEC_ID,
        body: bodyBytes,
        timestamp: ts,
        secret: SECRET,
    });
    return { payload, signature: sig, timestamp: ts };
}

function badEnvelope(payload: unknown, ts: number = Math.floor(NOW_MS / 1000)): ExecEventMessage {
    return { payload, signature: "deadbeef".repeat(8), timestamp: ts };
}

function nullSigEnvelope(payload: unknown): ExecEventMessage {
    return { payload, signature: null, timestamp: null };
}

function stubRecv(messages: (ExecEventMessage | null)[]) {
    let i = 0;
    return async <T>(_topic: string, _timeoutSec: number): Promise<T | null> => {
        const m = i < messages.length ? messages[i++] : null;
        return m as unknown as T | null;
    };
}

function doneMarker(result: ExecResult) {
    return { done: true, result };
}

const okResult: ExecResult = {
    execId: EXEC_ID,
    exitCode: 0,
    stdout: "hello\n",
    stderr: "",
    durationMs: 12,
    timedOut: false,
};

describe("awaitExec", () => {
    test("verified event is forwarded to emit; done-marker returns the result", async () => {
        const emitted: unknown[] = [];
        const result = await awaitExecCallback(
            REF,
            EXEC_ID,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                ...NO_PULL,
                recv: stubRecv([envelope({ kind: "file-tree", added: ["/x.txt"] }), envelope(doneMarker(okResult))]),
            },
        );

        expect(emitted).toEqual([{ kind: "file-tree", added: ["/x.txt"] }]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello\n");
    });

    test("verifies HMAC against payloadRaw, not a JS re-serialization", async () => {
        // sandbox-server's Go `encoding/json` HTML-escapes `<`, `>`, `&` by
        // default. JavaScript's `JSON.stringify` does not. If the recv loop
        // re-serialized the parsed payload to verify the HMAC, the digest
        // would diverge for any output carrying those characters (FASTA
        // headers, shell pipelines, command output). This envelope simulates
        // sandbox-server's HTML-escaped bytes against an HTML-safe-escaped
        // payload to prove the raw bytes are what we verify.
        const sandboxBytes = '{"text":"\\u003ehdr"}';
        const ts = Math.floor(NOW_MS / 1000);
        const sig = signCallback({
            execId: EXEC_ID,
            body: Buffer.from(sandboxBytes, "utf8"),
            timestamp: ts,
            secret: SECRET,
        });
        const env: ExecEventMessage = {
            payload: { text: ">hdr" }, // parsed form — re-serializing it would lose the > escape
            payloadRaw: sandboxBytes,
            signature: sig,
            timestamp: ts,
        };
        const emitted: unknown[] = [];
        await awaitExecCallback(
            REF,
            EXEC_ID,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                ...NO_PULL,
                recv: stubRecv([env, envelope(doneMarker(okResult))]),
            },
        );
        expect(emitted).toEqual([{ text: ">hdr" }]);
    });

    test("bad signature hard-cancels", async () => {
        await expect(
            awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                ...NO_PULL,
                recv: stubRecv([badEnvelope({ kind: "phase", phase: "running" })]),
            }),
        ).rejects.toBeInstanceOf(HardCancelError);
    });

    test("stale timestamp hard-cancels", async () => {
        const stale = Math.floor(NOW_MS / 1000) - (FRESHNESS + 10);
        try {
            await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                ...NO_PULL,
                recv: stubRecv([envelope({ kind: "phase" }, stale)]),
            });
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(HardCancelError);
            expect((err as HardCancelError).reason).toBe("stale-timestamp");
        }
    });

    test("synthetic-failure (null signature, kind tag) returns the failure result", async () => {
        const failureResult: ExecResult = {
            execId: EXEC_ID,
            exitCode: null,
            stdout: "",
            stderr: "",
            durationMs: null,
            timedOut: false,
            syntheticFailure: { reason: "sandbox-dead" },
        };
        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            ...NO_PULL,
            recv: stubRecv([
                nullSigEnvelope({
                    done: true,
                    result: failureResult,
                    kind: "synthetic-failure",
                    reason: "sandbox-dead",
                }),
            ]),
        });
        expect(result.syntheticFailure?.reason).toBe("sandbox-dead");
    });

    test("null-signature without synthetic-failure marker hard-cancels", async () => {
        try {
            await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                ...NO_PULL,
                recv: stubRecv([nullSigEnvelope({ done: true, result: okResult })]),
            });
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(HardCancelError);
            expect((err as HardCancelError).reason).toBe("synthetic-without-marker");
        }
    });

    test("deadline exceeded throws ExecTimeoutError", async () => {
        // First recv times out (returns null), and the clock advances past
        // the deadline before the next iteration starts.
        let calls = 0;
        let mockNow = NOW_MS;
        await expect(
            awaitExecCallback(REF, EXEC_ID, () => {}, NOW_MS + 1000, {
                now: () => mockNow,
                freshnessSec: FRESHNESS,
                ...NO_PULL,
                recv: async () => {
                    calls++;
                    mockNow += 2000;
                    return null;
                },
            }),
        ).rejects.toBeInstanceOf(ExecTimeoutError);
        expect(calls).toBe(1);
    });

    test("done-marker with a populated provenance frame round-trips", async () => {
        const withProv: ExecResult = {
            ...okResult,
            provenance: {
                disabled: false,
                reads: [{ path: "/r/data/x.csv", layers: ["python"] }],
                writes: [{ path: "/r/runs/run/step/output/y.csv", layers: ["inotify"] }],
                deletes: [],
            },
        };
        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            ...NO_PULL,
            recv: stubRecv([envelope(doneMarker(withProv))]),
        });
        expect(result.provenance?.reads).toEqual([{ path: "/r/data/x.csv", layers: ["python"] }]);
        expect(result.provenance?.writes).toEqual([{ path: "/r/runs/run/step/output/y.csv", layers: ["inotify"] }]);
    });

    test("done-marker omitting provenance parses without throwing", async () => {
        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            ...NO_PULL,
            recv: stubRecv([envelope(doneMarker(okResult))]),
        });
        expect(result.provenance).toBeUndefined();
    });

    test("multiple events then a done-marker", async () => {
        const emitted: unknown[] = [];
        const result = await awaitExecCallback(
            REF,
            EXEC_ID,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                ...NO_PULL,
                recv: stubRecv([
                    envelope({ kind: "file-tree", added: ["/a.txt"] }),
                    envelope({ kind: "phase", phase: "running" }),
                    envelope({ kind: "file-tree", added: ["/b.txt"] }),
                    envelope(doneMarker(okResult)),
                ]),
            },
        );
        expect(emitted).toHaveLength(3);
        expect(result.exitCode).toBe(0);
    });
});

/**
 * The pull path — `GET /exec/{execId}` — is what stops a lost completion
 * callback from wedging a recovered run (#41). A host that restarts mid-exec
 * comes back on a new ingress port, so the push can never land; the loop must
 * stop waiting and ask.
 */
describe("awaitExec pull recovery", () => {
    /** A terminal `GET /exec/{execId}` response: bare completion bytes, signed fresh. */
    function completedResponse(payload: unknown, ts: number = Math.floor(NOW_MS / 1000), secret: string = SECRET): Response {
        const raw = JSON.stringify(payload);
        const sig = signCallback({ execId: EXEC_ID, body: Buffer.from(raw, "utf8"), timestamp: ts, secret });
        return new Response(raw, {
            status: 200,
            headers: { "content-type": "application/json", "x-sandbox-signature": sig, "x-sandbox-timestamp": String(ts) },
        });
    }

    /** sandbox-server leaves a still-running exec unsigned — it has nothing to attest yet. */
    function runningResponse(): Response {
        return new Response(JSON.stringify({ execId: EXEC_ID, status: "running" }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    }

    const silentRecv = async <T>(): Promise<T | null> => null;

    test("a quiet topic pulls the result and returns it", async () => {
        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: silentRecv,
            runStep: passthroughStep,
            pullAfterSilentSlices: 2,
            fetch: async () => completedResponse(okResult),
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello\n");
    });

    test("the pulled result carries the provenance frame", async () => {
        const withProv: ExecResult = {
            ...okResult,
            provenance: {
                disabled: false,
                reads: [{ path: "/r/data/x.csv", layers: ["python"] }],
                writes: [{ path: "/r/runs/run/step/output/y.csv", layers: ["inotify"] }],
                deletes: [],
            },
        };
        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: silentRecv,
            runStep: passthroughStep,
            pullAfterSilentSlices: 1,
            fetch: async () => completedResponse(withProv),
        });
        // A pull that re-marshalled the result instead of serving the callback's
        // own bytes would silently drop this — and provenance is the point.
        expect(result.provenance?.reads).toEqual([{ path: "/r/data/x.csv", layers: ["python"] }]);
        expect(result.provenance?.writes).toEqual([{ path: "/r/runs/run/step/output/y.csv", layers: ["inotify"] }]);
    });

    test("pulls only after the configured run of silent slices", async () => {
        let fetches = 0;
        await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: silentRecv,
            runStep: passthroughStep,
            pullAfterSilentSlices: 4,
            fetch: async () => {
                fetches += 1;
                return completedResponse(okResult);
            },
        });
        // Four null recvs, then exactly one pull — not one pull per slice.
        expect(fetches).toBe(1);
    });

    test("a push arriving before the pull threshold wins; no pull is issued", async () => {
        let fetches = 0;
        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: stubRecv([null, envelope(doneMarker(okResult))]),
            runStep: passthroughStep,
            pullAfterSilentSlices: 5,
            fetch: async () => {
                fetches += 1;
                return completedResponse(okResult);
            },
        });
        expect(result.exitCode).toBe(0);
        expect(fetches).toBe(0);
    });

    test("a silent run is reset by an event, so a chatty exec never pulls", async () => {
        let fetches = 0;
        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            // Two silences, an event, two more silences, then the done-marker.
            // With a threshold of 3 the run never reaches it.
            recv: stubRecv([null, null, envelope({ kind: "phase", phase: "running" }), null, null, envelope(doneMarker(okResult))]),
            runStep: passthroughStep,
            pullAfterSilentSlices: 3,
            fetch: async () => {
                fetches += 1;
                return completedResponse(okResult);
            },
        });
        expect(result.exitCode).toBe(0);
        expect(fetches).toBe(0);
    });

    test("a running exec keeps waiting; a later push still wins", async () => {
        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: stubRecv([null, null, envelope(doneMarker(okResult))]),
            runStep: passthroughStep,
            pullAfterSilentSlices: 1,
            fetch: async () => runningResponse(),
        });
        expect(result.exitCode).toBe(0);
    });

    test("an unreachable sandbox does not fail the exec — the deadline still governs", async () => {
        let mockNow = NOW_MS;
        let fetches = 0;
        await expect(
            awaitExecCallback(REF, EXEC_ID, () => {}, NOW_MS + 3000, {
                now: () => mockNow,
                freshnessSec: FRESHNESS,
                recv: async () => {
                    mockNow += 1000;
                    return null;
                },
                runStep: passthroughStep,
                pullAfterSilentSlices: 1,
                fetch: async () => {
                    fetches += 1;
                    throw new TypeError("connect ECONNREFUSED");
                },
            }),
        ).rejects.toBeInstanceOf(ExecTimeoutError);
        // A pull that threw would have failed the enclosing DBOS step and taken
        // the workflow with it. It must degrade to "keep waiting".
        expect(fetches).toBeGreaterThan(0);
    });

    test("the deadline check pulls once more before declaring a timeout", async () => {
        // The exec finished; only the callback was lost. Reporting a timeout here
        // would discard a completed analysis. This is the #41 wedge, unwedged.
        let mockNow = NOW_MS;
        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, NOW_MS + 1000, {
            now: () => mockNow,
            freshnessSec: FRESHNESS,
            recv: async () => {
                mockNow += 2000; // blow past the deadline in one slice
                return null;
            },
            runStep: passthroughStep,
            // High enough that the silent-slice path never fires: the only pull
            // that can happen is the one guarding the deadline.
            pullAfterSilentSlices: 1000,
            fetch: async () => completedResponse(okResult, Math.floor(mockNow / 1000)),
        });
        expect(result.exitCode).toBe(0);
    });

    test("a forged pulled result hard-cancels", async () => {
        await expect(
            awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                recv: silentRecv,
                runStep: passthroughStep,
                pullAfterSilentSlices: 1,
                fetch: async () =>
                    completedResponse(okResult, Math.floor(NOW_MS / 1000), "base64:" + Buffer.from("a-different-32-byte-secret-value").toString("base64")),
            }),
        ).rejects.toBeInstanceOf(HardCancelError);
    });

    test("a stale pulled signature hard-cancels", async () => {
        const stale = Math.floor(NOW_MS / 1000) - (FRESHNESS + 10);
        try {
            await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                recv: silentRecv,
                runStep: passthroughStep,
                pullAfterSilentSlices: 1,
                fetch: async () => completedResponse(okResult, stale),
            });
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(HardCancelError);
            expect((err as HardCancelError).reason).toBe("stale-timestamp");
        }
    });

    test("an unsigned 200 is treated as still-running, not as a completion", async () => {
        let mockNow = NOW_MS;
        await expect(
            awaitExecCallback(REF, EXEC_ID, () => {}, NOW_MS + 2000, {
                now: () => mockNow,
                freshnessSec: FRESHNESS,
                recv: async () => {
                    mockNow += 1000;
                    return null;
                },
                runStep: passthroughStep,
                pullAfterSilentSlices: 1,
                // An unsigned body claiming success must never be accepted: the
                // signature's presence is what marks a response terminal.
                fetch: async () => new Response(JSON.stringify(okResult), { status: 200 }),
            }),
        ).rejects.toBeInstanceOf(ExecTimeoutError);
    });

    test("pull verifies the raw bytes, not a JS re-serialization", async () => {
        // Go's encoding/json HTML-escapes `>`; JSON.stringify does not. The
        // signature covers the bytes on the wire, so the pull must verify those.
        const raw = '{"execId":"wf-1:step-a:fn-0","exitCode":0,"stdout":"\\u003ehdr","stderr":"","durationMs":1,"timedOut":false}';
        const ts = Math.floor(NOW_MS / 1000);
        const sig = signCallback({ execId: EXEC_ID, body: Buffer.from(raw, "utf8"), timestamp: ts, secret: SECRET });

        const result = await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: silentRecv,
            runStep: passthroughStep,
            pullAfterSilentSlices: 1,
            fetch: async () =>
                new Response(raw, {
                    status: 200,
                    headers: { "x-sandbox-signature": sig, "x-sandbox-timestamp": String(ts) },
                }),
        });
        expect(result.stdout).toBe(">hdr");
    });

    test("each pull gets a distinct, replay-stable step name", async () => {
        const names: string[] = [];
        let mockNow = NOW_MS;
        await expect(
            awaitExecCallback(REF, EXEC_ID, () => {}, NOW_MS + 3000, {
                now: () => mockNow,
                freshnessSec: FRESHNESS,
                recv: async () => {
                    mockNow += 1000;
                    return null;
                },
                runStep: async (fn, config) => {
                    names.push(config.name);
                    return fn();
                },
                pullAfterSilentSlices: 1,
                fetch: async () => runningResponse(),
            }),
        ).rejects.toBeInstanceOf(ExecTimeoutError);

        // DBOS caches step output by call order; duplicate names across a single
        // workflow make the recorded sequence unreadable.
        expect(names.length).toBeGreaterThan(1);
        expect(new Set(names).size).toBe(names.length);
        expect(names[0]).toBe(`sandbox.pull-exec-result.${EXEC_ID}.1`);
    });

    test("a pull URL escapes the execId's colons", async () => {
        let seen = "";
        await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: silentRecv,
            runStep: passthroughStep,
            pullAfterSilentSlices: 1,
            fetch: async (input) => {
                seen = String(input);
                return completedResponse(okResult);
            },
        });
        expect(seen).toBe(`http://127.0.0.1:8765/exec/${encodeURIComponent(EXEC_ID)}`);
    });

    test("the pull request carries a valid signature over the empty GET body", async () => {
        let headers: Record<string, string> = {};
        await awaitExecCallback(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: silentRecv,
            runStep: passthroughStep,
            pullAfterSilentSlices: 1,
            fetch: async (_input, init) => {
                headers = (init?.headers ?? {}) as Record<string, string>;
                return completedResponse(okResult);
            },
        });
        // sandbox-server verifies the inbound GET the same way it verifies a
        // callback: HMAC over `execId:ts:sha256("")`. Recompute and confirm.
        const timestamp = Number.parseInt(headers["x-sandbox-timestamp"]!, 10);
        const verdict = verifyCallback({
            execId: EXEC_ID,
            body: "",
            signature: headers["x-sandbox-signature"]!,
            timestamp,
            secret: SECRET,
            nowSec: timestamp,
            freshnessSec: FRESHNESS,
        });
        expect(verdict.valid).toBe(true);
    });
});

// ── Poll transport ──────────────────────────────────────────────────

/** A signed poll response, mirroring the Go server's `pollResponseBody`. */
function signedPoll(body: Record<string, unknown>, ts: number = Math.floor(NOW_MS / 1000)): Response {
    const raw = JSON.stringify(body);
    const sig = signCallback({ execId: EXEC_ID, body: Buffer.from(raw, "utf8"), timestamp: ts, secret: SECRET });
    return new Response(raw, { status: 200, headers: { "x-sandbox-signature": sig, "x-sandbox-timestamp": String(ts) } });
}

/** Returns the canned poll bodies in order, latching on the last, recording URLs. */
function pollFetch(bodies: Record<string, unknown>[], urls: string[] = []): typeof fetch {
    let i = 0;
    return (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        const body = i < bodies.length ? bodies[i++] : bodies[bodies.length - 1];
        return signedPoll(body);
    }) as typeof fetch;
}

/** Poll-loop options that never really sleep or spin DBOS. */
const POLL_BASE = { now: () => NOW_MS, runStep: passthroughStep, sleep: async () => {} } as const;

describe("awaitExecPoll", () => {
    test("returns the terminal result once the poll carries one", async () => {
        const result = await awaitExecPoll(REF, EXEC_ID, () => {}, DEADLINE, {
            ...POLL_BASE,
            fetch: pollFetch([
                { status: "running", events: [], cursor: 0 },
                { status: "completed", events: [], cursor: 0, result: okResult },
            ]),
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello\n");
    });

    test("forwards incremental events once and advances the cursor", async () => {
        const emitted: unknown[] = [];
        const urls: string[] = [];
        const result = await awaitExecPoll(
            REF,
            EXEC_ID,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                ...POLL_BASE,
                fetch: pollFetch(
                    [
                        {
                            status: "running",
                            events: [
                                { seq: 1, payload: { kind: "file-tree", added: ["/x"] } },
                                { seq: 2, payload: { kind: "phase", phase: "run" } },
                            ],
                            cursor: 2,
                        },
                        { status: "completed", events: [{ seq: 3, payload: { kind: "phase", phase: "done" } }], cursor: 3, result: okResult },
                    ],
                    urls,
                ),
            },
        );
        expect(result.exitCode).toBe(0);
        // 2 progress events from the first poll + 1 trailing event alongside the result.
        expect(emitted.length).toBe(3);
        // The first poll starts at cursor 0; the second must carry the advanced cursor.
        expect(urls[0]).toContain("?since=0");
        expect(urls[1]).toContain("?since=2");
    });

    test("events at or below the local cursor are never re-emitted", async () => {
        // The poll signature covers the body, not the request's `since`, so any
        // validly-signed snapshot verifies against any poll. A replayed or
        // crossed response re-serving delivered events must be deduped locally.
        const emitted: unknown[] = [];
        await awaitExecPoll(
            REF,
            EXEC_ID,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                ...POLL_BASE,
                fetch: pollFetch([
                    {
                        status: "running",
                        events: [
                            { seq: 1, payload: { kind: "phase", phase: "setup" } },
                            { seq: 2, payload: { kind: "phase", phase: "run" } },
                        ],
                        cursor: 2,
                    },
                    // A stale snapshot for since=0: seqs 1-2 again plus the new seq 3.
                    {
                        status: "completed",
                        events: [
                            { seq: 1, payload: { kind: "phase", phase: "setup" } },
                            { seq: 2, payload: { kind: "phase", phase: "run" } },
                            { seq: 3, payload: { kind: "phase", phase: "done" } },
                        ],
                        cursor: 3,
                        result: okResult,
                    },
                ]),
            },
        );
        expect(emitted).toEqual([
            { kind: "phase", phase: "setup" },
            { kind: "phase", phase: "run" },
            { kind: "phase", phase: "done" },
        ]);
    });

    test("the cadence backs off after the fast-phase attempts are spent", async () => {
        // Each durable poll writes a step row; a fixed 1.5s cadence over an
        // hours-long exec floods the DBOS system tables. Fast early (short execs
        // return promptly), slow later (long execs poll sustainably).
        const sleeps: number[] = [];
        const running = { status: "running", events: [], cursor: 0 };
        await awaitExecPoll(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            runStep: passthroughStep,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            pollIntervalMs: 1_500,
            fastPollAttempts: 2,
            slowPollIntervalMs: 10_000,
            fetch: pollFetch([running, running, running, running, { status: "completed", events: [], cursor: 0, result: okResult }]),
        });
        expect(sleeps).toEqual([1_500, 1_500, 10_000, 10_000]);
    });

    test("a seq gap above the cursor — events shed by ring overflow — is surfaced via warn", async () => {
        const warnings: string[] = [];
        await awaitExecPoll(REF, EXEC_ID, () => {}, DEADLINE, {
            ...POLL_BASE,
            warn: (m) => warnings.push(m),
            fetch: pollFetch([
                // The ring shed seqs 1-40 before the host's first poll.
                { status: "running", events: [{ seq: 41, payload: { kind: "phase", phase: "run" } }], cursor: 41, truncated: true },
                { status: "completed", events: [], cursor: 41, result: okResult },
            ]),
        });
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("40");
    });

    test("a fully-shed ring — cursor advanced past events never served — is surfaced via warn", async () => {
        const warnings: string[] = [];
        await awaitExecPoll(REF, EXEC_ID, () => {}, DEADLINE, {
            ...POLL_BASE,
            warn: (m) => warnings.push(m),
            fetch: pollFetch([
                { status: "running", events: [], cursor: 7, truncated: true },
                { status: "completed", events: [], cursor: 7, result: okResult },
            ]),
        });
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("7");
    });

    test("contiguous events never warn", async () => {
        const warnings: string[] = [];
        await awaitExecPoll(REF, EXEC_ID, () => {}, DEADLINE, {
            ...POLL_BASE,
            warn: (m) => warnings.push(m),
            fetch: pollFetch([
                { status: "running", events: [{ seq: 1, payload: { kind: "phase", phase: "setup" } }], cursor: 1 },
                { status: "completed", events: [{ seq: 2, payload: { kind: "phase", phase: "done" } }], cursor: 2, result: okResult },
            ]),
        });
        expect(warnings).toEqual([]);
    });

    test("a forged poll response hard-cancels", async () => {
        const forgedFetch: typeof fetch = async () =>
            new Response(JSON.stringify({ status: "running", events: [], cursor: 0 }), {
                status: 200,
                headers: { "x-sandbox-signature": "deadbeef".repeat(8), "x-sandbox-timestamp": String(Math.floor(NOW_MS / 1000)) },
            });
        await expect(awaitExecPoll(REF, EXEC_ID, () => {}, DEADLINE, { ...POLL_BASE, fetch: forgedFetch })).rejects.toBeInstanceOf(HardCancelError);
    });

    test("each poll gets a distinct, replay-stable step name", async () => {
        const names: string[] = [];
        await awaitExecPoll(REF, EXEC_ID, () => {}, DEADLINE, {
            now: () => NOW_MS,
            sleep: async () => {},
            runStep: async (fn, config) => {
                names.push(config.name);
                return fn();
            },
            fetch: pollFetch([
                { status: "running", events: [], cursor: 0 },
                { status: "completed", events: [], cursor: 0, result: okResult },
            ]),
        });
        expect(names).toEqual([`sandbox.poll-exec-result.${EXEC_ID}.1`, `sandbox.poll-exec-result.${EXEC_ID}.2`]);
    });

    test("a deadline already crossed still polls once — a finished exec is returned, not timed out", async () => {
        // Mirrors the callback loop's ask-once-before-timeout: a lost poll window
        // is not a slow command, and the result may be sitting in the sandbox.
        const result = await awaitExecPoll(REF, EXEC_ID, () => {}, NOW_MS - 1, {
            ...POLL_BASE,
            fetch: pollFetch([{ status: "completed", events: [], cursor: 0, result: okResult }]),
        });
        expect(result.exitCode).toBe(0);
    });

    test("an unreachable sandbox keeps polling until the deadline, then times out", async () => {
        let mockNow = NOW_MS;
        await expect(
            awaitExecPoll(REF, EXEC_ID, () => {}, NOW_MS + 3000, {
                now: () => mockNow,
                runStep: passthroughStep,
                sleep: async () => {
                    mockNow += 1000;
                },
                // Every poll 404s (unavailable) — never terminal.
                fetch: noPullFetch,
            }),
        ).rejects.toBeInstanceOf(ExecTimeoutError);
    });
});

describe("awaitExec transport dispatch", () => {
    test("defaults to poll — drives fetch, never recv", async () => {
        let recvCalled = false;
        const result = await awaitExec(REF, EXEC_ID, () => {}, DEADLINE, {
            ...POLL_BASE,
            recv: async () => {
                recvCalled = true;
                return null;
            },
            fetch: pollFetch([{ status: "completed", events: [], cursor: 0, result: okResult }]),
        });
        expect(result.exitCode).toBe(0);
        expect(recvCalled).toBe(false);
    });

    test("transport:callback runs the recv loop — a done-marker returns without any pull", async () => {
        let fetchCalled = false;
        const result = await awaitExec(REF, EXEC_ID, () => {}, DEADLINE, {
            transport: "callback",
            now: () => NOW_MS,
            runStep: passthroughStep,
            fetch: async () => {
                fetchCalled = true;
                return new Response("unexpected", { status: 404 });
            },
            recv: stubRecv([envelope(doneMarker(okResult))]),
        });
        expect(result.exitCode).toBe(0);
        expect(fetchCalled).toBe(false);
    });
});
