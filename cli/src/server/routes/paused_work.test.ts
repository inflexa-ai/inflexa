import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ChatTurnSession, Work, WorkSurface } from "@inflexa-ai/harness";

import type { HeldWork, PausedWorkList, ResumedWork } from "../../api/paused_work.ts";
import type { ServerBootState } from "../../api/server.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { idleBoot } from "../../test_support/server.ts";
import type { ServerBoot } from "../boot.ts";
import { DEFAULT_PAUSED_WORK_ROUTE_OPTS, pausedWorkRoutes, type PausedWorkRouteOpts } from "./paused_work.ts";

// The routes alone, mounted under the path of the app, with no bearer check: `app.test.ts` covers that. No cli test
// reaches Postgres, thus the paused work of the runtime is a fake over items in memory. Each `as` cast of a body
// below reads JSON that the route under test builds from the same `src/api/` type.

const A = "analysis-1";
const PAUSED_AT = "2026-10-27T10:00:00.000Z";

/** A turn whose model endpoint refused the credential. */
const CREDENTIAL_TURN: Work = {
    workId: "turn-1",
    kind: "turn",
    analysisId: A,
    threadId: "thread-1",
    waiting: [{ workflowId: "turn-1", state: "paused", cause: { kind: "credential" }, attempt: 0, pausedAt: PAUSED_AT }],
};

/** A run whose two steps wait: one on a refusal of the host, one on the timer of an outage. */
const PAUSED_RUN: Work = {
    workId: "run-1",
    kind: "run",
    analysisId: A,
    waiting: [
        { workflowId: "run-1-0", state: "paused", cause: { kind: "host", reason: "payment_required" }, attempt: 0, pausedAt: PAUSED_AT },
        { workflowId: "run-1-1", state: "retrying", cause: { kind: "outage" }, attempt: 1, retryAt: "2026-10-27T10:05:00.000Z", pausedAt: PAUSED_AT },
    ],
};

/** A fake of the paused work of the runtime, with each resume that it got. */
function fakePausedWork(items: Work[]): WorkSurface & { resumed: { session: ChatTurnSession; workId: string }[]; held: string[]; listed: string[] } {
    const resumed: { session: ChatTurnSession; workId: string }[] = [];
    const held: string[] = [];
    const listed: string[] = [];
    return {
        resumed,
        held,
        listed,
        list: async (analysisId) => {
            listed.push(analysisId);
            return items.filter((work) => work.analysisId === analysisId);
        },
        stop: async () => ({ kind: "not_found" }),
        resume: async (session, workId) => {
            resumed.push({ session, workId });
            const work = items.find((item) => item.workId === workId && item.analysisId === session.scope.analysisId);
            return work === undefined ? { kind: "not_found" } : { kind: "resumed", workflows: work.waiting.length };
        },
        hold: async (session, workId) => {
            held.push(workId);
            const work = items.find((item) => item.workId === workId && item.analysisId === session.scope.analysisId);
            return work === undefined ? { kind: "not_found" } : { kind: "held", workflows: work.waiting.filter((wait) => wait.state === "retrying").length };
        },
    };
}

/** A boot whose runtime is ready. The routes read only the paused work of the runtime. */
function readyBoot(work: WorkSurface): ServerBoot {
    // The cast is sound for the reason above: no route under test reads another field of the runtime.
    const runtime = { work } as unknown as HarnessRuntime;
    const state: ServerBootState = {
        version: "0.0.0-test",
        apiVersion: 1,
        startedAt: new Date().toISOString(),
        phase: "ready",
        connection: { provider: "anthropic", mode: "cliproxy", model: "m" },
    };
    return { state: () => state, runtime: () => runtime, start: async () => undefined };
}

/** The routes under the mount path of the app, thus the `analysisId` parameter resolves as it does in the app. */
function appWith(boot: ServerBoot, over: Partial<PausedWorkRouteOpts> = {}): { request: (path: string, init?: RequestInit) => Promise<Response> } {
    const app = new Hono();
    app.route(
        "/api/v1/analyses/:analysisId/paused-work",
        pausedWorkRoutes(boot, { ...DEFAULT_PAUSED_WORK_ROUTE_OPTS, connection: () => ({ provider: "anthropic", mode: "cliproxy" }), ...over }),
    );
    return { request: async (path, init) => app.request(`/api/v1/analyses/${A}/paused-work${path}`, init) };
}

describe("GET {A}/paused-work", () => {
    test("gives the paused work of the analysis and not the work that runs, and the remedy of a failed turn on an item with the cause `credential`", async () => {
        const running: Work = { workId: "run-running", kind: "run", analysisId: A, waiting: [] };
        const paused = fakePausedWork([CREDENTIAL_TURN, running, PAUSED_RUN, { ...PAUSED_RUN, workId: "run-elsewhere", analysisId: "analysis-2" }]);
        const response = await appWith(readyBoot(paused)).request("");

        expect(response.status).toBe(200);
        const body = (await response.json()) as PausedWorkList;
        expect(paused.listed).toEqual([A]);
        expect(body.total).toBe(2);
        expect(body.pausedWork.map((work) => work.workId)).toEqual(["turn-1", "run-1"]);
        // The `cliproxy` remedy of a dead login names the command that signs in again.
        expect(body.pausedWork[0]?.remedy).toContain("run `inflexa up` in a terminal to sign in again");
        expect(body.pausedWork[1]?.remedy).toBeUndefined();
        expect(body.pausedWork[1]?.waiting.map((wait) => [wait.state, wait.cause.kind, wait.attempt])).toEqual([
            ["paused", "host", 0],
            ["retrying", "outage", 1],
        ]);
    });

    test("the remedy of a `direct` connection names the key variable, the same as for a failed turn", async () => {
        const response = await appWith(readyBoot(fakePausedWork([CREDENTIAL_TURN])), { connection: () => ({ provider: "openai", mode: "direct" }) }).request(
            "",
        );
        const body = (await response.json()) as PausedWorkList;
        expect(body.pausedWork[0]?.remedy).toContain("INFLEXA_MODEL_API_KEY");
    });

    test("a failed list gives 500 `internal_error`", async () => {
        const failing: WorkSurface = {
            list: () => Promise.reject(new Error("relation cortex_paused_work does not exist")),
            stop: async () => ({ kind: "not_found" }),
            resume: async () => ({ kind: "not_found" }),
            hold: async () => ({ kind: "not_found" }),
        };
        const response = await appWith(readyBoot(failing)).request("");
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ error: "internal_error" });
    });
});

describe("POST {A}/paused-work/:workId/resume", () => {
    test("resumes the work with the session of the server, and gives the count of the resumed workflows", async () => {
        const paused = fakePausedWork([PAUSED_RUN]);
        const response = await appWith(readyBoot(paused)).request("/run-1/resume", { method: "POST" });

        expect(response.status).toBe(200);
        expect((await response.json()) as ResumedWork).toEqual({ workId: "run-1", workflows: 2 });
        expect(paused.resumed).toHaveLength(1);
        expect(paused.resumed[0]?.workId).toBe("run-1");
        expect(paused.resumed[0]?.session.scope).toEqual({ kind: "analysis", analysisId: A });
    });

    test("a renewal that the host refuses gives 403 `forbidden` with its reason", async () => {
        const refusing: WorkSurface = {
            list: async () => [PAUSED_RUN],
            stop: async () => ({ kind: "not_found" }),
            resume: async () => ({ kind: "refused", reason: "only the subject can renew" }),
            hold: async () => ({ kind: "not_found" }),
        };
        const response = await appWith(readyBoot(refusing)).request("/run-1/resume", { method: "POST" });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "forbidden", message: "The work stays paused: only the subject can renew" });
    });

    test("an id that no paused work of the analysis has gives 404 `not_found`", async () => {
        const response = await appWith(readyBoot(fakePausedWork([PAUSED_RUN]))).request("/run-unknown/resume", { method: "POST" });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found" });
    });
});

describe("POST {A}/paused-work/:workId/hold", () => {
    test("holds the work, and gives the count of the waits in retrying that it moved to paused", async () => {
        const paused = fakePausedWork([PAUSED_RUN]);
        const response = await appWith(readyBoot(paused)).request("/run-1/hold", { method: "POST" });

        expect(response.status).toBe(200);
        expect((await response.json()) as HeldWork).toEqual({ workId: "run-1", workflows: 1 });
        expect(paused.held).toEqual(["run-1"]);
    });

    test("an id that no paused work of the analysis has gives 404 `not_found`", async () => {
        const response = await appWith(readyBoot(fakePausedWork([PAUSED_RUN]))).request("/run-unknown/hold", { method: "POST" });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found" });
    });
});

describe("with no runtime", () => {
    test("the two routes give 503 `unavailable`", async () => {
        const app = appWith(idleBoot());
        expect((await app.request("")).status).toBe(503);
        expect((await app.request("/run-1/resume", { method: "POST" })).status).toBe(503);
    });
});
