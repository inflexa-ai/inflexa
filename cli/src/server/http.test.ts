import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { ServerState } from "../api/server.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import type { ServerBoot } from "./boot.ts";
import { apiError, listEnvelope, parsePage, requireRuntime, sseResponse, type ServerEnv } from "./http.ts";

describe("apiError", () => {
    test("each code gets its status, and `details` only when given", async () => {
        const app = new Hono();
        app.get("/plain", (c) => apiError(c, "not_found", "gone"));
        app.get("/detailed", (c) => apiError(c, "busy", "work runs", { reasons: ["turn"] }));
        app.get("/down", (c) => apiError(c, "unavailable", "starting", { phase: "starting" }));

        const plain = await app.request("/plain");
        expect(plain.status).toBe(404);
        expect(await plain.json()).toEqual({ error: "not_found", message: "gone" });

        const detailed = await app.request("/detailed");
        expect(detailed.status).toBe(409);
        expect(await detailed.json()).toEqual({ error: "busy", message: "work runs", details: { reasons: ["turn"] } });

        expect((await app.request("/down")).status).toBe(503);
    });
});

describe("parsePage", () => {
    test("no values give page 0 and the default perPage", () => {
        expect(parsePage(undefined, undefined)).toEqual({ page: 0, perPage: 100 });
    });

    test("valid values pass through", () => {
        expect(parsePage("3", "25")).toEqual({ page: 3, perPage: 25 });
    });

    test("a bad value falls back to its default, never an error", () => {
        expect(parsePage("-1", "abc")).toEqual({ page: 0, perPage: 100 });
        expect(parsePage("1.5", "0")).toEqual({ page: 0, perPage: 100 });
    });

    test("a perPage above the cap gives the cap", () => {
        expect(parsePage("0", "5000")).toEqual({ page: 0, perPage: 200 });
    });
});

describe("listEnvelope", () => {
    test("the items go under the resource key, with the paging fields", () => {
        expect(listEnvelope("threads", ["a", "b"], 5, { page: 0, perPage: 2 })).toEqual({ threads: ["a", "b"], total: 5, page: 0, perPage: 2, hasMore: true });
    });

    test("the last page has no more", () => {
        expect(listEnvelope("runs", ["e"], 5, { page: 2, perPage: 2 }).hasMore).toBe(false);
        expect(listEnvelope("runs", [], 0, { page: 0, perPage: 100 }).hasMore).toBe(false);
    });
});

describe("requireRuntime", () => {
    const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;
    // The middleware only passes the handle on, so a stand-in object is enough to prove that it arrives.
    const runtime = { tag: "runtime" } as unknown as HarnessRuntime;

    function bootIn(state: ServerState, rt: HarnessRuntime | null): ServerBoot {
        return { state: () => state, runtime: () => rt, start: async () => undefined };
    }

    function appFor(boot: ServerBoot): Hono<ServerEnv> {
        const app = new Hono<ServerEnv>();
        app.get("/needs", requireRuntime(boot), (c) => c.json({ same: c.get("runtime") === runtime }));
        return app;
    }

    test("503 `unavailable` with details.phase while the boot is starting or failed", async () => {
        const starting = await appFor(bootIn({ ...identity, phase: "starting" }, null)).request("/needs");
        expect(starting.status).toBe(503);
        expect(await starting.json()).toMatchObject({ error: "unavailable", details: { phase: "starting" } });

        const failedState: ServerState = { ...identity, phase: "failed", bootError: { reason: "x", message: "y", detailLines: [] } };
        const failed = await appFor(bootIn(failedState, null)).request("/needs");
        expect(failed.status).toBe(503);
        expect(await failed.json()).toMatchObject({ error: "unavailable", details: { phase: "failed" } });
    });

    test("a ready boot hands the runtime to the handler", async () => {
        const readyState: ServerState = { ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m" } };
        const response = await appFor(bootIn(readyState, runtime)).request("/needs");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ same: true });
    });
});

/** Read the whole body of an SSE response as text. */
async function readAll(response: Response): Promise<string> {
    return await new Response(response.body).text();
}

describe("sseResponse", () => {
    test("the stream opens with the `: open` comment, each frame is one `data:` line of JSON and a blank line, and the stream closes when the producer settles", async () => {
        const response = sseResponse(async (writer) => {
            writer.send({ type: "a", n: 1 });
            writer.send({ type: "b" });
        });
        expect(response.headers.get("Content-Type")).toBe("text/event-stream");
        expect(response.headers.get("Cache-Control")).toBe("no-cache");
        expect(await readAll(response)).toBe(': open\n\ndata: {"type":"a","n":1}\n\ndata: {"type":"b"}\n\n');
    });

    test("a quiet stream sends the `: ping` comment on the interval", async () => {
        const response = sseResponse(
            async (writer) => {
                await Promise.sleep(40);
                writer.send({ type: "done" });
            },
            { pingMs: 10, headers: { "Inflexa-Turn-Id": "t-1" } },
        );
        expect(response.headers.get("Inflexa-Turn-Id")).toBe("t-1");
        const text = await readAll(response);
        expect(text).toContain(": ping\n\n");
        expect(text.endsWith('data: {"type":"done"}\n\n')).toBe(true);
    });

    test("a rejected producer closes the stream after the frames it sent", async () => {
        const response = sseResponse(async (writer) => {
            writer.send({ type: "first" });
            throw new Error("producer broke");
        });
        expect(await readAll(response)).toBe(': open\n\ndata: {"type":"first"}\n\n');
    });

    test("a client disconnect aborts the signal of the producer, and a later send does nothing", async () => {
        let laterSend: Promise<"sent" | "threw"> = Promise.resolve("threw");
        const response = sseResponse(async (writer) => {
            writer.send({ type: "first" });
            laterSend = new Promise((resolve) =>
                writer.signal.addEventListener("abort", () => {
                    try {
                        writer.send({ type: "after the disconnect" });
                        resolve("sent");
                    } catch {
                        resolve("threw");
                    }
                }),
            );
            await laterSend;
        });
        // `sseResponse` always gives a stream body.
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();
        expect(await laterSend).toBe("sent");
    });

    test("over a real listener, the client gets the response headers before the first frame", async () => {
        // The headers carry the id that a client needs to abort a turn, thus they cannot wait for the first frame.
        let releaseFirstFrame: () => void = () => undefined;
        const firstFrame = new Promise<void>((resolve) => {
            releaseFirstFrame = resolve;
        });
        const app = new Hono().get("/", () =>
            sseResponse(
                async (writer) => {
                    await firstFrame;
                    writer.send({ type: "first" });
                },
                { pingMs: 60_000, headers: { "Inflexa-Turn-Id": "t-1" } },
            ),
        );
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
        const headers = fetch(`http://127.0.0.1:${server.port}/`).then(
            async (response) => {
                const turnId = response.headers.get("Inflexa-Turn-Id");
                await response.body?.cancel();
                return turnId;
            },
            (cause: unknown) => `the request failed: ${String(cause)}`,
        );
        try {
            const first = await Promise.race([headers, Promise.sleep(1_000).then(() => "no response headers 1 s after the request")]);
            expect(first).toBe("t-1");
        } finally {
            releaseFirstFrame();
            await headers;
            await server.stop(true);
        }
    });
});
