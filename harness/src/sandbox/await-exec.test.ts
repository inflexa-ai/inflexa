/**
 * Recv-loop contract tests — does not spin DBOS. `awaitExec`'s `recv`
 * argument is injected with a hand-written stub that returns canned
 * envelopes in order.
 */

import { describe, expect, test } from "bun:test";
import { awaitExec, ExecTimeoutError, HardCancelError } from "./await-exec.js";
import { signCallback } from "./hmac.js";
import type { ExecEventMessage, ExecResult } from "./types.js";

const EXEC_ID = "wf-1:step-a:fn-0";
const SECRET = "base64:" + Buffer.from("01234567890123456789012345678901").toString("base64");
const NOW_MS = 1_700_000_000_000;
const FRESHNESS = 300;
const DEADLINE = NOW_MS + 60_000;

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
        const result = await awaitExec(
            EXEC_ID,
            SECRET,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
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
        await awaitExec(
            EXEC_ID,
            SECRET,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                recv: stubRecv([env, envelope(doneMarker(okResult))]),
            },
        );
        expect(emitted).toEqual([{ text: ">hdr" }]);
    });

    test("bad signature hard-cancels", async () => {
        await expect(
            awaitExec(EXEC_ID, SECRET, () => {}, DEADLINE, {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
                recv: stubRecv([badEnvelope({ kind: "phase", phase: "running" })]),
            }),
        ).rejects.toBeInstanceOf(HardCancelError);
    });

    test("stale timestamp hard-cancels", async () => {
        const stale = Math.floor(NOW_MS / 1000) - (FRESHNESS + 10);
        try {
            await awaitExec(EXEC_ID, SECRET, () => {}, DEADLINE, {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
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
        const result = await awaitExec(EXEC_ID, SECRET, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
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
            await awaitExec(EXEC_ID, SECRET, () => {}, DEADLINE, {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
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
            awaitExec(EXEC_ID, SECRET, () => {}, NOW_MS + 1000, {
                now: () => mockNow,
                freshnessSec: FRESHNESS,
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
        const result = await awaitExec(EXEC_ID, SECRET, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: stubRecv([envelope(doneMarker(withProv))]),
        });
        expect(result.provenance?.reads).toEqual([{ path: "/r/data/x.csv", layers: ["python"] }]);
        expect(result.provenance?.writes).toEqual([{ path: "/r/runs/run/step/output/y.csv", layers: ["inotify"] }]);
    });

    test("done-marker omitting provenance parses without throwing", async () => {
        const result = await awaitExec(EXEC_ID, SECRET, () => {}, DEADLINE, {
            now: () => NOW_MS,
            freshnessSec: FRESHNESS,
            recv: stubRecv([envelope(doneMarker(okResult))]),
        });
        expect(result.provenance).toBeUndefined();
    });

    test("multiple events then a done-marker", async () => {
        const emitted: unknown[] = [];
        const result = await awaitExec(
            EXEC_ID,
            SECRET,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                now: () => NOW_MS,
                freshnessSec: FRESHNESS,
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
