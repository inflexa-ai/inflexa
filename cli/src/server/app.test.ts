import { describe, expect, test } from "bun:test";
import { errAsync, ok, okAsync } from "neverthrow";

import type { ServerActivity, ServerState, ShutdownMode } from "../api/server.ts";
import type { ClientOpts } from "../client/api.ts";
import { fetchServerState } from "../client/server.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import { idleLifecycle } from "../test_support/server.ts";
import { buildApp } from "./app.ts";
import type { ServerBoot } from "./boot.ts";
import type { ServerLifecycle } from "./lifecycle.ts";
import { serverRoutes, type ServerRouteOpts } from "./routes/server.ts";

const TOKEN = "a".repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;

/** A boot that holds `state` and counts the calls of `start`. */
function fakeBoot(state: ServerState): { boot: ServerBoot; starts: () => number } {
    let starts = 0;
    return {
        boot: {
            state: () => state,
            runtime: () => null,
            start: async () => {
                starts += 1;
            },
        },
        starts: () => starts,
    };
}

describe("the bearer check", () => {
    const { boot } = fakeBoot({ ...identity, phase: "starting" });
    const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot });

    test("no Authorization header gives 401 `unauthorized`", async () => {
        const response = await app.request("/api/v1/server");
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: "unauthorized" });
    });

    test("a wrong token, a token of a different length, or a different scheme gives 401", async () => {
        for (const header of [`Bearer ${"b".repeat(64)}`, "Bearer short", `Basic ${TOKEN}`]) {
            const response = await app.request("/api/v1/server", { headers: { Authorization: header } });
            expect(response.status).toBe(401);
        }
    });

    test("the right token passes", async () => {
        expect((await app.request("/api/v1/server", { headers: AUTH })).status).toBe(200);
    });

    test("an unknown path under /api/ is checked first, then gives 404 `not_found`", async () => {
        expect((await app.request("/api/v1/nothing")).status).toBe(401);
        const response = await app.request("/api/v1/nothing", { headers: AUTH });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found" });
    });
});

describe("GET /api/v1/server", () => {
    test("gives the state of each phase as the boot holds it", async () => {
        const states: ServerState[] = [
            { ...identity, phase: "starting" },
            { ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "claude-test" } },
            { ...identity, phase: "failed", bootError: { reason: "postgres_unavailable", message: "start Postgres", detailLines: ["ECONNREFUSED"] } },
        ];
        for (const state of states) {
            const response = await buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot: fakeBoot(state).boot }).request("/api/v1/server", {
                headers: AUTH,
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual(state);
        }
    });
});

describe("POST /api/v1/server/boot", () => {
    test("starts the boot and gives 202 with the state", async () => {
        const failed: ServerState = { ...identity, phase: "failed", bootError: { reason: "x", message: "y", detailLines: [] } };
        const fake = fakeBoot(failed);
        const response = await buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot: fake.boot }).request("/api/v1/server/boot", {
            method: "POST",
            headers: AUTH,
        });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual(failed);
        expect(fake.starts()).toBe(1);
    });
});

describe("a handler that throws", () => {
    test("gives 500 `internal_error` with generic text, never the cause", async () => {
        const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot: fakeBoot({ ...identity, phase: "starting" }).boot });
        app.get("/api/v1/boom", () => {
            throw new Error("secret internal detail");
        });
        const response = await app.request("/api/v1/boom", { headers: AUTH });
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body).toMatchObject({ error: "internal_error" });
        expect(JSON.stringify(body)).not.toContain("secret internal detail");
    });
});

describe("the client against the app (no port)", () => {
    const state: ServerState = { ...identity, phase: "ready", connection: { provider: "openai", mode: "direct", model: "gpt-test" } };
    const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot: fakeBoot(state).boot });
    const clientWith = (token: string): ClientOpts => ({
        discover: () => ok({ baseUrl: "http://127.0.0.1:8436", token }),
        fetch: async (url, init) => await app.request(url, init),
    });

    test("fetchServerState gives the state that the route sends", async () => {
        expect((await fetchServerState(clientWith(TOKEN)))._unsafeUnwrap()).toEqual(state);
    });

    test("a stale token is an `http` 401 with the `unauthorized` body", async () => {
        expect((await fetchServerState(clientWith("c".repeat(64))))._unsafeUnwrapErr()).toMatchObject({
            type: "http",
            status: 401,
            body: { error: "unauthorized" },
        });
    });
});

/** A lifecycle that records each stop request, and keeps the mode of the first, as the real one does. */
function recordingLifecycle(activeTurns: number): ServerLifecycle & { requests: ShutdownMode[] } {
    const requests: ShutdownMode[] = [];
    let first: ShutdownMode | null = null;
    return {
        requests,
        requestShutdown: (mode) => {
            requests.push(mode);
            first ??= mode;
            return { mode: first, activeTurns };
        },
        stopping: () => first,
    };
}

describe("POST /api/v1/server/shutdown", () => {
    const idle = fakeBoot({ ...identity, phase: "starting" }).boot;

    test.each([["now"], ["drain"]] as const)("mode %s gives 202 at once, with the mode and the running turns", async (mode) => {
        const lifecycle = recordingLifecycle(2);
        const response = await buildApp({ token: TOKEN, boot: idle, lifecycle }).request("/api/v1/server/shutdown", {
            method: "POST",
            headers: { ...AUTH, "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
        });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ mode, activeTurns: 2 });
        expect(lifecycle.requests).toEqual([mode]);
    });

    test("a mode that is not `now` or `drain` gives 400 `validation_error`, and starts no stop", async () => {
        const lifecycle = recordingLifecycle(0);
        const response = await buildApp({ token: TOKEN, boot: idle, lifecycle }).request("/api/v1/server/shutdown", {
            method: "POST",
            headers: { ...AUTH, "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "later" }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "validation_error" });
        expect(lifecycle.requests).toEqual([]);
    });

    test("needs the bearer token", async () => {
        const lifecycle = recordingLifecycle(0);
        const response = await buildApp({ token: TOKEN, boot: idle, lifecycle }).request("/api/v1/server/shutdown", {
            method: "POST",
            body: JSON.stringify({ mode: "now" }),
        });
        expect(response.status).toBe(401);
        expect(lifecycle.requests).toEqual([]);
    });
});

describe("GET /api/v1/server/activity", () => {
    const counts = (durable: ServerRouteOpts["durableWork"]): ServerRouteOpts => ({
        runningTurnCount: () => 1,
        profileWorkCount: () => 2,
        durableWork: durable,
    });
    // The route passes the pool of the runtime to the ledger read and reads nothing else of it.
    const runtime = { pool: {} } as unknown as HarnessRuntime;
    const readyBoot: ServerBoot = { state: () => ({ ...identity, phase: "starting" }), runtime: () => runtime, start: async () => undefined };

    async function activity(boot: ServerBoot, opts: ServerRouteOpts, lifecycle: ServerLifecycle = idleLifecycle()): Promise<ServerActivity> {
        const response = await serverRoutes(boot, lifecycle, opts).request("/activity");
        expect(response.status).toBe(200);
        // The route builds the body from `ServerActivity`.
        return (await response.json()) as ServerActivity;
    }

    test("counts the turns, the profile drives, and the durable work of the ledger", async () => {
        const body = await activity(
            readyBoot,
            counts(() => okAsync({ runs: 3, profiles: 1 })),
        );
        expect(body).toEqual({ stopping: null, turns: 1, profileDrives: 2, durable: { state: "counted", runs: 3, profiles: 1 } });
    });

    test("with no runtime, no workflow runs in the server", async () => {
        const body = await activity(
            fakeBoot({ ...identity, phase: "starting" }).boot,
            counts(() => okAsync({ runs: 9, profiles: 9 })),
        );
        expect(body.durable).toEqual({ state: "no_runtime" });
    });

    test("a ledger read that fails is `unreadable`, and a stop in progress shows its mode", async () => {
        const lifecycle = recordingLifecycle(0);
        lifecycle.requestShutdown("drain");
        const body = await activity(
            readyBoot,
            counts(() => errAsync(new Error("pg down"))),
            lifecycle,
        );
        expect(body.durable).toEqual({ state: "unreadable" });
        expect(body.stopping).toBe("drain");
    });
});
