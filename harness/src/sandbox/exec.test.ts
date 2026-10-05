/**
 * Exec contract tests — the submit, the poll loop, the liveness escalation, and
 * the cancel read. Every effect is injected, thus no test touches DBOS or a socket.
 */

import { Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { describe, expect, test } from "bun:test";

import { EXEC_STREAM_BYTE_CAP } from "../tools/workspace/result-bounds.js";
import { ExecTimeoutError, runExec, type ExecDeps } from "./exec.js";
import { PROBE_AFTER_UNAVAILABLE_POLLS } from "./liveness.js";
import type { ExecResult, SandboxLiveness, SandboxRef } from "./types.js";

const EXEC_ID = "an-1:run-1-0:7";
const NOW_MS = 1_700_000_000_000;
const DEADLINE = NOW_MS + 60_000;

const REF: SandboxRef = {
    sandboxId: "sb-1",
    host: "127.0.0.1",
    port: 8765,
    backend: "docker",
};

const REQUEST = { command: ["echo", "hi"] } as const;

const okResult: ExecResult = {
    execId: EXEC_ID,
    exitCode: 0,
    stdout: "hello\n",
    stderr: "",
    durationMs: 12,
    timedOut: false,
};

/** A poll response, mirroring the Go server's `pollResponseBody`. */
function pollResponse(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), { status: 200 });
}

interface SeenRequest {
    readonly url: string;
    readonly init?: RequestInit;
}

/**
 * A sandbox: a POST to `/exec` gets a 202, and each poll gets the next item,
 * latching on the last. `"unavailable"` answers a poll with a 404.
 */
function sandbox(polls: (Record<string, unknown> | "unavailable")[], seen: SeenRequest[] = []): typeof fetch {
    let i = 0;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), ...(init ? { init } : {}) });
        if (init?.method === "POST") return new Response(JSON.stringify({ status: "started" }), { status: 202 });
        const item = i < polls.length ? polls[i++] : polls[polls.length - 1];
        return item === "unavailable" ? new Response("unknown execId", { status: 404 }) : pollResponse(item!);
    }) as typeof fetch;
}

/** Deps that never really sleep and never see a cancel. */
const BASE: ExecDeps = { now: () => NOW_MS, sleep: async () => {}, isCancelled: async () => false };

/** A sleep that advances the mock clock, thus a deadline-bounded loop ends. */
function tickingClock(stepMs = 1000) {
    const clock = { nowMs: NOW_MS };
    return {
        clock,
        now: () => clock.nowMs,
        sleep: async () => {
            clock.nowMs += stepMs;
        },
    };
}

const completed = { status: "completed", events: [], cursor: 0, result: okResult };

describe("the submit", () => {
    test("POSTs the request with the exec id and the default retention budget", async () => {
        const seen: SeenRequest[] = [];
        await runExec(REF, EXEC_ID, { command: ["echo", "hi"], cwd: "/an-1" }, () => {}, DEADLINE, { ...BASE, fetch: sandbox([completed], seen) });

        const post = seen.find((r) => r.init?.method === "POST")!;
        expect(post.url).toBe("http://127.0.0.1:8765/exec");
        expect(JSON.parse(post.init!.body as string)).toEqual({
            command: ["echo", "hi"],
            execId: EXEC_ID,
            cwd: "/an-1",
            stdoutByteCap: EXEC_STREAM_BYTE_CAP,
            stderrByteCap: EXEC_STREAM_BYTE_CAP,
        });
    });

    test("attaches a budget of 1 MiB for each stream to a body that carries none", async () => {
        const seen: SeenRequest[] = [];
        await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, { ...BASE, fetch: sandbox([completed], seen) });

        const body = JSON.parse(seen[0]!.init!.body as string) as Record<string, unknown>;
        expect(body.stdoutByteCap).toBe(1_048_576);
        expect(body.stderrByteCap).toBe(1_048_576);
    });

    test("sends the configured retention budget", async () => {
        const seen: SeenRequest[] = [];
        await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, { ...BASE, execStreamByteCap: 1234, fetch: sandbox([completed], seen) });

        const body = JSON.parse(seen[0]!.init!.body as string) as Record<string, unknown>;
        expect(body.stdoutByteCap).toBe(1234);
        expect(body.stderrByteCap).toBe(1234);
    });

    test("a non-202 throws, and no poll follows", async () => {
        const seen: SeenRequest[] = [];
        const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
            seen.push({ url: String(input), ...(init ? { init } : {}) });
            return new Response("boom", { status: 503 });
        }) as typeof fetch;
        await expect(runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, { ...BASE, fetch: failing })).rejects.toThrow(/503/);
        expect(seen).toHaveLength(1);
    });

    test("the poll URL escapes the colons of the exec id", async () => {
        const seen: SeenRequest[] = [];
        await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, { ...BASE, fetch: sandbox([completed], seen) });

        expect(seen[1]!.url).toBe(`http://127.0.0.1:8765/exec/${encodeURIComponent(EXEC_ID)}?since=0`);
    });
});

describe("the poll loop", () => {
    test("returns the terminal result once the poll carries one", async () => {
        const result = await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            fetch: sandbox([{ status: "running", events: [], cursor: 0 }, completed]),
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hello\n");
    });

    test("forwards incremental events once and advances the cursor", async () => {
        const emitted: unknown[] = [];
        const seen: SeenRequest[] = [];
        await runExec(
            REF,
            EXEC_ID,
            REQUEST,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                ...BASE,
                fetch: sandbox(
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
                    seen,
                ),
            },
        );
        expect(emitted).toHaveLength(3);
        expect(seen[1]!.url).toContain("?since=0");
        expect(seen[2]!.url).toContain("?since=2");
    });

    test("events at or below the local cursor are never emitted again", async () => {
        const emitted: unknown[] = [];
        await runExec(
            REF,
            EXEC_ID,
            REQUEST,
            (e) => {
                emitted.push(e);
            },
            DEADLINE,
            {
                ...BASE,
                fetch: sandbox([
                    {
                        status: "running",
                        events: [
                            { seq: 1, payload: { phase: "setup" } },
                            { seq: 2, payload: { phase: "run" } },
                        ],
                        cursor: 2,
                    },
                    {
                        status: "completed",
                        events: [
                            { seq: 1, payload: { phase: "setup" } },
                            { seq: 2, payload: { phase: "run" } },
                            { seq: 3, payload: { phase: "done" } },
                        ],
                        cursor: 3,
                        result: okResult,
                    },
                ]),
            },
        );
        expect(emitted).toEqual([{ phase: "setup" }, { phase: "run" }, { phase: "done" }]);
    });

    test("the cadence backs off after the fast-phase attempts are spent", async () => {
        const sleeps: number[] = [];
        const running = { status: "running", events: [], cursor: 0 };
        await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            fetch: sandbox([...Array.from({ length: 41 }, () => running), completed]),
        });
        expect(sleeps).toHaveLength(41);
        expect(sleeps.slice(0, 40)).toEqual(Array.from({ length: 40 }, () => 1_500));
        expect(sleeps[40]).toBe(10_000);
    });

    test("a seq gap above the cursor — events that the ring shed — is surfaced through warn", async () => {
        const warnings: string[] = [];
        await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            warn: (m) => warnings.push(m),
            fetch: sandbox([
                { status: "running", events: [{ seq: 41, payload: { phase: "run" } }], cursor: 41, truncated: true },
                { status: "completed", events: [], cursor: 41, result: okResult },
            ]),
        });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("40");
    });

    test("a fully shed ring — a cursor past events never served — is surfaced through warn", async () => {
        const warnings: string[] = [];
        await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            warn: (m) => warnings.push(m),
            fetch: sandbox([
                { status: "running", events: [], cursor: 7, truncated: true },
                { status: "completed", events: [], cursor: 7, result: okResult },
            ]),
        });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("7");
    });

    test("contiguous events never warn", async () => {
        const warnings: string[] = [];
        await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            warn: (m) => warnings.push(m),
            fetch: sandbox([
                { status: "running", events: [{ seq: 1, payload: { phase: "setup" } }], cursor: 1 },
                { status: "completed", events: [{ seq: 2, payload: { phase: "done" } }], cursor: 2, result: okResult },
            ]),
        });
        expect(warnings).toEqual([]);
    });

    test("a deadline already crossed still polls once — a finished exec is returned, not timed out", async () => {
        const result = await runExec(REF, EXEC_ID, REQUEST, () => {}, NOW_MS - 1, { ...BASE, fetch: sandbox([completed]) });
        expect(result.exitCode).toBe(0);
    });

    test("an unreachable sandbox keeps polling until the deadline, then times out", async () => {
        const { now, sleep } = tickingClock();
        await expect(runExec(REF, EXEC_ID, REQUEST, () => {}, NOW_MS + 3000, { ...BASE, now, sleep, fetch: sandbox(["unavailable"]) })).rejects.toBeInstanceOf(
            ExecTimeoutError,
        );
    });
});

describe("the liveness escalation", () => {
    const T = PROBE_AFTER_UNAVAILABLE_POLLS;

    test("a dead machine fast-fails with a synthetic failure instead of waiting out the deadline", async () => {
        const { now, sleep, clock } = tickingClock();
        let probes = 0;
        const result = await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            now,
            sleep,
            fetch: sandbox(["unavailable"]),
            isAlive: async () => {
                probes++;
                return { alive: false, oomKilled: false };
            },
        });
        expect(result.syntheticFailure?.reason).toBe("sandbox-dead");
        expect(result.execId).toBe(EXEC_ID);
        expect(probes).toBe(1);
        expect(clock.nowMs).toBeLessThan(DEADLINE - 30_000);
    });

    test("an OOM-killed machine carries the OOM reason", async () => {
        const { now, sleep } = tickingClock();
        const result = await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            now,
            sleep,
            fetch: sandbox(["unavailable"]),
            isAlive: async () => ({ alive: false, oomKilled: true }),
        });
        expect(result.syntheticFailure?.reason).toBe("sandbox-oom-killed");
    });

    test("a live but slow machine never escalates to failure — the deadline still bounds", async () => {
        const { now, sleep } = tickingClock();
        let probes = 0;
        await expect(
            runExec(REF, EXEC_ID, REQUEST, () => {}, NOW_MS + 6000, {
                ...BASE,
                now,
                sleep,
                fetch: sandbox(["unavailable"]),
                isAlive: async () => {
                    probes++;
                    return { alive: true, oomKilled: false };
                },
            }),
        ).rejects.toBeInstanceOf(ExecTimeoutError);
        expect(probes).toBe(1);
    });

    test("an ok poll resets the streak — no probe ever runs", async () => {
        let probes = 0;
        const result = await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            fetch: sandbox([
                ...Array.from({ length: T - 1 }, () => "unavailable" as const),
                { status: "running", events: [], cursor: 0 },
                ...Array.from({ length: T - 1 }, () => "unavailable" as const),
                completed,
            ]),
            isAlive: async () => {
                probes++;
                return { alive: true, oomKilled: false };
            },
        });
        expect(result.exitCode).toBe(0);
        expect(probes).toBe(0);
    });

    test("a thrown probe is inconclusive — the loop resumes and the deadline bounds", async () => {
        const { now, sleep } = tickingClock();
        let probes = 0;
        await expect(
            runExec(REF, EXEC_ID, REQUEST, () => {}, NOW_MS + 6000, {
                ...BASE,
                now,
                sleep,
                fetch: sandbox(["unavailable"]),
                isAlive: async () => {
                    probes++;
                    throw new Error("docker daemon unreachable");
                },
            }),
        ).rejects.toBeInstanceOf(ExecTimeoutError);
        expect(probes).toBe(1);
    });

    test("a probe that finds the machine alive re-arms, and a later dead verdict ends the exec", async () => {
        const { now, sleep } = tickingClock();
        const verdicts: SandboxLiveness[] = [
            { alive: true, oomKilled: false },
            { alive: false, oomKilled: false },
        ];
        let probe = 0;
        const result = await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            now,
            sleep,
            fetch: sandbox(["unavailable"]),
            isAlive: async () => verdicts[probe++]!,
        });
        expect(result.syntheticFailure?.reason).toBe("sandbox-dead");
        expect(probe).toBe(2);
    });
});

describe("the cancel read", () => {
    const running = { status: "running", events: [], cursor: 0 };

    test("a cancelled workflow stops the exec with the DBOS cancel error", async () => {
        const { now, sleep } = tickingClock(5_000);
        await expect(
            runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, { ...BASE, now, sleep, fetch: sandbox([running]), isCancelled: async () => true }),
        ).rejects.toBeInstanceOf(DBOSErrors.DBOSWorkflowCancelledError);
    });

    test("the workflow status is read at most once for each interval", async () => {
        const { now, sleep } = tickingClock(1_500);
        let reads = 0;
        await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            now,
            sleep,
            // 20 running polls at 1.5 s each span 28.5 s of the clock: reads at 10.5 s and at 21 s.
            fetch: sandbox([...Array.from({ length: 20 }, () => running), completed]),
            isCancelled: async () => {
                reads++;
                return false;
            },
        });
        expect(reads).toBe(2);
    });

    test("a short exec never reads the workflow status", async () => {
        let reads = 0;
        await runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, {
            ...BASE,
            fetch: sandbox([running, completed]),
            isCancelled: async () => {
                reads++;
                return false;
            },
        });
        expect(reads).toBe(0);
    });
});

describe("the resource usage frame", () => {
    async function pollTo(result: Record<string, unknown>): Promise<ExecResult> {
        return runExec(REF, EXEC_ID, REQUEST, () => {}, DEADLINE, { ...BASE, fetch: sandbox([{ status: "completed", events: [], cursor: 0, result }]) });
    }

    test("a reported frame reaches the caller", async () => {
        const returned = await pollTo({ ...okResult, usage: { peakMemoryBytes: 3_221_225_472, cpuMillis: 7_500 } });
        expect(returned.usage).toEqual({ peakMemoryBytes: 3_221_225_472, cpuMillis: 7_500 });
    });

    // The sandbox image is versioned and promoted apart from the host, thus a
    // new host runs against an image that reports no accounting at all.
    test("an image that reports no frame still returns its result", async () => {
        const returned = await pollTo(okResult);
        expect(returned.exitCode).toBe(0);
        expect(returned.usage).toBeUndefined();
    });

    test("a malformed frame degrades to absent rather than failing the parse", async () => {
        const returned = await pollTo({ ...okResult, usage: "not-a-frame" });
        expect(returned.exitCode).toBe(0);
        expect(returned.usage).toBeUndefined();
    });
});
