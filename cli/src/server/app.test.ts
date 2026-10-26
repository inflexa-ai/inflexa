import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_ASSETS } from "@inflexa-ai/harness/report-render/assets.js";
import { errAsync, ok, okAsync } from "neverthrow";

import type { ServerActivity, ServerBootState, ServerState, ShutdownMode } from "../api/server.ts";
import type { ClientOpts } from "../client/api.ts";
import { fetchServerState } from "../client/server.ts";
import { insertAnalysis, insertAnchor } from "../db/primary_mutation.ts";
import { releaseInstanceLock } from "../lib/lock.ts";
import { asStr256 } from "../lib/types.ts";
import { invalidateWorkspaceRoot, workspaceRootForAnalysisId } from "../modules/analysis/output.ts";
import { writeMarker } from "../modules/anchor/marker.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import { signIn } from "../test_support/browser_session.ts";
import { freshDb } from "../test_support/db.ts";
import { idleLifecycle, startTestServer, type TestServer } from "../test_support/server.ts";
import { buildApp } from "./app.ts";
import type { ServerBoot } from "./boot.ts";
import type { ServerLifecycle } from "./lifecycle.ts";
import { createPageGrantStore } from "./report_page_grants.ts";
import { serverRoutes, type ServerRouteOpts } from "./routes/server.ts";

const TOKEN = "a".repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;

const STARTING: ServerBootState = { ...identity, phase: "starting", boot: { attemptStartedAt: identity.startedAt, step: null, done: [] } };

/** A boot that holds `state` and counts the calls of `start`. */
function fakeBoot(state: ServerBootState): { boot: ServerBoot; starts: () => number } {
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

describe("the credential check", () => {
    const { boot } = fakeBoot(STARTING);
    const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot, pageGrants: createPageGrantStore() });

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

describe("the file system routes", () => {
    // A boot with no runtime: the routes must answer while the runtime boot is not ready.
    const { boot } = fakeBoot(STARTING);
    const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot, pageGrants: createPageGrantStore() });
    const listPath = "/api/v1/fs/list?path=%2F";

    test("no credential gives 401, and the bearer token gives 200 before the runtime boot is ready", async () => {
        expect((await app.request(listPath)).status).toBe(401);
        expect((await app.request("/api/v1/fs/home")).status).toBe(401);
        const response = await app.request(listPath, { headers: AUTH });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ folder: { path: "/" }, entries: expect.any(Array) });
        expect((await app.request("/api/v1/fs/home", { headers: AUTH })).status).toBe(200);
    });
});

describe("the read route", () => {
    const { boot } = fakeBoot(STARTING);
    const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot, pageGrants: createPageGrantStore() });
    let home = "";
    let figure = "";

    beforeEach(async () => {
        freshDb();
        invalidateWorkspaceRoot();
        home = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-app-files-")));
        (await writeMarker(home, "A1"))._unsafeUnwrap();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis({ id: "a1", createdAt: 1, updatedAt: 1, name: asStr256("A"), slug: "a", anchorId: "A1", projectId: null })._unsafeUnwrap();
        const root = (await workspaceRootForAnalysisId("a1"))._unsafeUnwrap();
        mkdirSync(join(root, "runs", "R", "A", "figures"), { recursive: true });
        figure = join(root, "runs", "R", "A", "figures", "volcano.png");
        writeFileSync(figure, "png-bytes");
    });

    afterEach(() => {
        releaseInstanceLock("a1");
        rmSync(home, { recursive: true, force: true });
    });

    function readUrl(query = ""): string {
        return `/api/v1/fs/read?path=${encodeURIComponent(figure)}${query}`;
    }

    test("a browser with the session cookie of `signIn` gets the figure, and the bearer token gets it too", async () => {
        const cookie = await signIn(app, TOKEN);
        const response = await app.request(readUrl(), { headers: { Cookie: cookie } });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/png");
        expect(await response.text()).toBe("png-bytes");
        expect((await app.request(readUrl("&analysisId=a1"), { headers: AUTH })).status).toBe(200);
    });

    test("a request with no credential gets 401", async () => {
        const response = await app.request(readUrl());
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: "unauthorized" });
    });

    test("an unknown analysis gets 404 from the guard", async () => {
        const response = await app.request(readUrl("&analysisId=nope"), { headers: AUTH });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found", message: expect.stringContaining("nope") });
    });

    test("the route `GET {A}/files` does not exist: a known analysis gets the not-found message of the app, not the guard", async () => {
        const response = await app.request("/api/v1/analyses/a1/files?path=runs/R/A/figures/volcano.png", { headers: AUTH });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_found", message: "No route for GET /api/v1/analyses/a1/files." });
    });
});

describe("the session cookie", () => {
    const { boot } = fakeBoot(STARTING);
    const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot, pageGrants: createPageGrantStore() });
    const SIGN_IN_AGAIN = "Run `inflexa gui` again.";

    async function expectUnauthorized(response: Response, message: string): Promise<void> {
        expect(response.status).toBe(401);
        // An error body of the app is an `ApiError`.
        const body = (await response.json()) as { error: string; message: string };
        expect(body.error).toBe("unauthorized");
        expect(body.message).toContain(message);
    }

    test("a signed-in browser reaches an API route with the cookie and no Authorization header", async () => {
        const cookie = await signIn(app, TOKEN);
        const response = await app.request("/api/v1/server", { headers: { Cookie: cookie } });
        expect(response.status).toBe(200);
    });

    test("the bearer token still passes beside a cookie", async () => {
        const cookie = await signIn(app, TOKEN);
        expect((await app.request("/api/v1/server", { headers: { ...AUTH, Cookie: cookie } })).status).toBe(200);
    });

    test("a cookie of an unknown session gives 401 with the message that names `inflexa gui`", async () => {
        const name = (await signIn(app, TOKEN)).split("=")[0];
        const response = await app.request("/api/v1/server", { headers: { Cookie: `${name}=${"f".repeat(64)}` } });
        await expectUnauthorized(response, SIGN_IN_AGAIN);
    });

    test("a cookie of a restarted server gives 401 with the message that names `inflexa gui`", async () => {
        const cookie = await signIn(app, TOKEN);
        const restarted = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot, pageGrants: createPageGrantStore() });
        await expectUnauthorized(await restarted.request("/api/v1/server", { headers: { Cookie: cookie } }), SIGN_IN_AGAIN);
    });

    test("a cookie with a wrong name is no credential, and the message is the default one", async () => {
        const cookie = await signIn(app, TOKEN);
        const response = await app.request("/api/v1/server", { headers: { Cookie: cookie.replace("inflexa_session", "other_session") } });
        await expectUnauthorized(response, "Send the token");
    });

    test("the name of the cookie carries the port of the listener", async () => {
        const listener = { port: 8436 };
        const cookie = await signIn(app, TOKEN, listener);
        expect(cookie).toStartWith("inflexa_session_8436=");
        const headers = { Cookie: cookie, Host: "127.0.0.1:8436" };
        expect((await app.request("/api/v1/server", { headers }, listener)).status).toBe(200);
        // The production server on 8431 reads a cookie named for 8436 as no cookie.
        const other = { port: 8431 };
        await expectUnauthorized(await app.request("/api/v1/server", { headers: { Cookie: cookie, Host: "127.0.0.1:8431" } }, other), "Send the token");
    });

    test("Sec-Fetch-Site same-origin and none accept the cookie", async () => {
        const cookie = await signIn(app, TOKEN);
        for (const site of ["same-origin", "none"]) {
            expect((await app.request("/api/v1/server", { headers: { Cookie: cookie, "Sec-Fetch-Site": site } })).status).toBe(200);
        }
    });

    test("Sec-Fetch-Site same-site and cross-site ignore the cookie, with the message for a missing token", async () => {
        const cookie = await signIn(app, TOKEN);
        for (const site of ["same-site", "cross-site"]) {
            await expectUnauthorized(await app.request("/api/v1/server", { headers: { Cookie: cookie, "Sec-Fetch-Site": site } }), "Send the token");
        }
    });

    test("the bearer token passes whatever Sec-Fetch-Site says", async () => {
        expect((await app.request("/api/v1/server", { headers: { ...AUTH, "Sec-Fetch-Site": "same-site" } })).status).toBe(200);
    });

    test("only GET on exactly /api/v1/session needs no credential", async () => {
        // The sign-in route answers a GET with no nonce by itself: 401 with the sign-in message, not the default one.
        await expectUnauthorized(await app.request("/api/v1/session"), SIGN_IN_AGAIN);
        await expectUnauthorized(await app.request("/api/v1/session?nonce=abc"), SIGN_IN_AGAIN);
        // These requests are refused by the credential check, before any route.
        for (const [method, path] of [
            ["POST", "/api/v1/session"],
            ["GET", "/api/v1/session/"],
            ["GET", "/api/v1/session/nonce"],
        ] as const) {
            await expectUnauthorized(await app.request(path, { method }), "Send the token");
        }
    });
});

describe("the Host and Origin check", () => {
    const { boot } = fakeBoot(STARTING);
    const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot, pageGrants: createPageGrantStore() });
    // The Bun server that `Bun.serve` passes as `c.env`. The check reads the bound port from it.
    const listener = { port: 8436 };
    const send = async (headers: Record<string, string>, path = "/api/v1/server"): Promise<Response> => await app.request(path, { headers }, listener);

    async function expectForbidden(response: Response, header: "Host" | "Origin"): Promise<void> {
        expect(response.status).toBe(403);
        // An error body of the app is an `ApiError`.
        const body = (await response.json()) as { error: string; message: string };
        expect(body.error).toBe("forbidden");
        expect(body.message).toStartWith(`The ${header} header must be`);
    }

    test("a Host that is not the address of the server gives 403 `forbidden`, before the bearer check", async () => {
        for (const host of ["rebind.example:8436", "rebind.example", "127.0.0.1:9999", "127.0.0.1", "[::1]:8436", "0.0.0.0:8436"]) {
            await expectForbidden(await send({ Host: host }), "Host");
        }
    });

    test("a request with no Host header gives 403 `forbidden`", async () => {
        await expectForbidden(await send(AUTH), "Host");
    });

    test("each path is checked, not only the API", async () => {
        await expectForbidden(await send({ Host: "rebind.example:8436" }, "/gui/"), "Host");
    });

    test("each name of the server passes, in each case", async () => {
        for (const host of ["127.0.0.1:8436", "localhost:8436", "LOCALHOST:8436"]) {
            expect((await send({ ...AUTH, Host: host })).status).toBe(200);
        }
    });

    test("an Origin that is not the server gives 403 `forbidden`", async () => {
        for (const origin of ["http://rebind.example:8436", "null", "https://127.0.0.1:8436", "http://127.0.0.1:9999", "http://localhost"]) {
            await expectForbidden(await send({ ...AUTH, Host: "127.0.0.1:8436", Origin: origin }), "Origin");
        }
    });

    test("the origin of the server passes, by each of its names", async () => {
        for (const origin of ["http://127.0.0.1:8436", "http://localhost:8436"]) {
            expect((await send({ ...AUTH, Host: "127.0.0.1:8436", Origin: origin })).status).toBe(200);
        }
    });

    test("a real listener gives its bound port to the check", async () => {
        const server = startTestServer();
        try {
            const auth = { Authorization: `Bearer ${server.token}` };
            await expectForbidden(await fetch(`${server.baseUrl}/api/v1/server`, { headers: { ...auth, Host: `rebind.example:${server.port}` } }), "Host");
            await expectForbidden(await fetch(`${server.baseUrl}/api/v1/server`, { headers: { ...auth, Origin: "http://rebind.example" } }), "Origin");
            expect((await fetch(`${server.baseUrl}/api/v1/server`, { headers: auth })).status).toBe(200);
        } finally {
            await server.stop();
        }
    });
});

describe("the Origin null exception of the report pages", () => {
    // A font of the page asset manifest needs no grant, thus the page route answers it past the proof.
    const FONT_PATH = `/report-sessions/a1/t1/assets/${PAGE_ASSETS.find((asset) => asset.file.endsWith(".woff2"))!.file}`;
    let server: TestServer;

    beforeEach(() => {
        server = startTestServer();
    });

    afterEach(async () => {
        await server.stop();
    });

    async function expectForbidden(response: Response, header: "Host" | "Origin"): Promise<void> {
        expect(response.status).toBe(403);
        // An error body of the app is an `ApiError`.
        const body = (await response.json()) as { error: string; message: string };
        expect(body.error).toBe("forbidden");
        expect(body.message).toStartWith(`The ${header} header must be`);
    }

    test("a GET and a HEAD under `/report-sessions/` with `Origin: null` pass the check and reach the page route", async () => {
        for (const method of ["GET", "HEAD"]) {
            const response = await fetch(`${server.baseUrl}${FONT_PATH}`, { method, headers: { Origin: "null" } });
            // 404 comes from the page route, which finds no analysis `a1`. The check answered 403 before the route.
            expect(response.status).toBe(404);
            expect(response.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts allow-downloads");
        }
    });

    test("an `Origin: null` request to `/api/` gets 403 `forbidden`, also with the bearer token", async () => {
        const auth = { Authorization: `Bearer ${server.token}` };
        await expectForbidden(await fetch(`${server.baseUrl}/api/v1/projects`, { headers: { ...auth, Origin: "null" } }), "Origin");
        // A HEAD response has no body to read.
        expect((await fetch(`${server.baseUrl}/api/v1/server`, { method: "HEAD", headers: { ...auth, Origin: "null" } })).status).toBe(403);
    });

    test("the exception is for GET and HEAD only, and it keeps the Host check and the check of a named origin", async () => {
        await expectForbidden(await fetch(`${server.baseUrl}${FONT_PATH}`, { method: "POST", headers: { Origin: "null" } }), "Origin");
        await expectForbidden(await fetch(`${server.baseUrl}${FONT_PATH}`, { headers: { Origin: "null", Host: `rebind.example:${server.port}` } }), "Host");
        await expectForbidden(await fetch(`${server.baseUrl}${FONT_PATH}`, { headers: { Origin: "http://rebind.example" } }), "Origin");
    });
});

describe("the web GUI", () => {
    const deps = { token: TOKEN, lifecycle: idleLifecycle(), boot: fakeBoot(STARTING).boot, pageGrants: createPageGrantStore() };

    test("the default app serves the placeholder page at /gui/ with no credential", async () => {
        const response = await buildApp(deps).request("/gui/");
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toStartWith("text/html");
        const page = await response.text();
        expect(page).toContain("<title>Inflexa</title>");
        expect(page).toContain("Not implemented");
        expect(page).not.toContain("<script");
    });

    test("/gui with no trailing slash moves to /gui/, where the page is", async () => {
        const response = await buildApp(deps).request("/gui");
        expect(response.status).toBe(301);
        expect(response.headers.get("Location")).toBe("/gui/");
    });
});

describe("GET /api/v1/server", () => {
    test("gives the state of each phase as the boot holds it", async () => {
        const states: ServerBootState[] = [
            {
                ...STARTING,
                boot: {
                    attemptStartedAt: "2026-10-02T00:00:01.000Z",
                    step: { id: "images", startedAt: "2026-10-02T00:00:03.000Z", progress: { doneBytes: 40, totalBytes: 120 } },
                    done: [{ id: "container_engine", startedAt: "2026-10-02T00:00:01.000Z", endedAt: "2026-10-02T00:00:03.000Z" }],
                },
            },
            { ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "claude-test" } },
            {
                ...identity,
                phase: "failed",
                bootError: { reason: "postgres_unavailable", message: "start Postgres", detailLines: ["ECONNREFUSED"] },
                attemptStartedAt: "2026-10-02T00:00:01.000Z",
                failedAt: "2026-10-02T00:00:09.000Z",
                failedStep: "containers",
            },
        ];
        for (const state of states) {
            const response = await buildApp({
                token: TOKEN,
                lifecycle: idleLifecycle(),
                boot: fakeBoot(state).boot,
                pageGrants: createPageGrantStore(),
            }).request("/api/v1/server", {
                headers: AUTH,
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ ...state, stopping: null });
        }
    });

    test("gives the mode of a stop in progress in each phase, and the phase does not change", async () => {
        const ready: ServerBootState = { ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "claude-test" } };
        for (const state of [STARTING, ready]) {
            const lifecycle = recordingLifecycle(0);
            const app = buildApp({ token: TOKEN, lifecycle, boot: fakeBoot(state).boot, pageGrants: createPageGrantStore() });
            const read = async (): Promise<unknown> => (await app.request("/api/v1/server", { headers: AUTH })).json();
            expect(await read()).toEqual({ ...state, stopping: null });

            const stop = await app.request("/api/v1/server/shutdown", {
                method: "POST",
                headers: { ...AUTH, "Content-Type": "application/json" },
                body: JSON.stringify({ mode: "drain" }),
            });
            expect(stop.status).toBe(202);
            expect(await read()).toEqual({ ...state, stopping: "drain" });
        }
    });
});

describe("POST /api/v1/server/boot", () => {
    test("starts the boot and gives 202 with the state", async () => {
        const failed: ServerBootState = {
            ...identity,
            phase: "failed",
            bootError: { reason: "x", message: "y", detailLines: [] },
            attemptStartedAt: identity.startedAt,
            failedAt: identity.startedAt,
            failedStep: null,
        };
        const fake = fakeBoot(failed);
        const response = await buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot: fake.boot, pageGrants: createPageGrantStore() }).request(
            "/api/v1/server/boot",
            {
                method: "POST",
                headers: AUTH,
            },
        );
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ ...failed, stopping: null });
        expect(fake.starts()).toBe(1);
    });

    test("gives the mode of a stop in progress in the 202 body", async () => {
        const lifecycle = recordingLifecycle(0);
        lifecycle.requestShutdown("now");
        const response = await buildApp({ token: TOKEN, lifecycle, boot: fakeBoot(STARTING).boot, pageGrants: createPageGrantStore() }).request(
            "/api/v1/server/boot",
            {
                method: "POST",
                headers: AUTH,
            },
        );
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ phase: "starting", stopping: "now" });
    });
});

describe("a handler that throws", () => {
    test("gives 500 `internal_error` with generic text, never the cause", async () => {
        const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot: fakeBoot(STARTING).boot, pageGrants: createPageGrantStore() });
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
    const state: ServerBootState = { ...identity, phase: "ready", connection: { provider: "openai", mode: "direct", model: "gpt-test" } };
    const app = buildApp({ token: TOKEN, lifecycle: idleLifecycle(), boot: fakeBoot(state).boot, pageGrants: createPageGrantStore() });
    const clientWith = (token: string): ClientOpts => ({
        discover: () => ok({ baseUrl: "http://127.0.0.1:8436", token }),
        fetch: async (url, init) => await app.request(url, init),
    });

    test("fetchServerState gives the state that the route sends", async () => {
        expect((await fetchServerState(clientWith(TOKEN)))._unsafeUnwrap()).toEqual({ ...state, stopping: null } satisfies ServerState);
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
        stopForSignal: () => undefined,
        stoppedBySignal: () => false,
    };
}

describe("POST /api/v1/server/shutdown", () => {
    const idle = fakeBoot(STARTING).boot;

    test.each([["now"], ["drain"]] as const)("mode %s gives 202 at once, with the mode and the running turns", async (mode) => {
        const lifecycle = recordingLifecycle(2);
        const response = await buildApp({ token: TOKEN, boot: idle, lifecycle, pageGrants: createPageGrantStore() }).request("/api/v1/server/shutdown", {
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
        const response = await buildApp({ token: TOKEN, boot: idle, lifecycle, pageGrants: createPageGrantStore() }).request("/api/v1/server/shutdown", {
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
        const response = await buildApp({ token: TOKEN, boot: idle, lifecycle, pageGrants: createPageGrantStore() }).request("/api/v1/server/shutdown", {
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
    const readyBoot: ServerBoot = { state: () => STARTING, runtime: () => runtime, start: async () => undefined };

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
            fakeBoot(STARTING).boot,
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
