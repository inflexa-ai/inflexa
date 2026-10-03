import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";

import { describeClientError, readSseFrames, request, streamRequest, type ClientError, type ClientOpts } from "./api.ts";

const BASE = "http://127.0.0.1:8436";

/** Client opts with a fixed endpoint, whose fetch gives `respond(url, init)` and records each call. */
function withFetch(respond: (url: string, init: RequestInit) => Promise<Response>): { opts: ClientOpts; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
        opts: {
            discover: () => ok({ baseUrl: BASE, token: "tok" }),
            fetch: (url, init) => {
                calls.push({ url, init });
                return respond(url, init);
            },
        },
        calls,
    };
}

const json = (body: unknown, status = 200): Promise<Response> => Promise.resolve(Response.json(body, { status }));

/** The headers of a recorded call. `send` always builds them as a plain object, never as a `Headers` or an array. */
const headersOf = (call: { init: RequestInit } | undefined): Record<string, string> => (call?.init.headers ?? {}) as Record<string, string>;

/** A body stream that gives each of `chunks` as one read. */
function chunked(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
}

/** Collect each item of an SSE reader. */
async function collect<T>(frames: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const frame of frames) out.push(frame);
    return out;
}

describe("request", () => {
    test("sends the bearer token and the JSON body, and gives the JSON of a success", async () => {
        const { opts, calls } = withFetch(() => json({ projects: [], total: 0 }));
        const result = await request<{ projects: string[]; total: number }>("POST", "/api/v1/projects", { body: { name: "p" } }, opts);
        expect(result._unsafeUnwrap()).toEqual({ projects: [], total: 0 });
        expect(calls[0]?.url).toBe(`${BASE}/api/v1/projects`);
        expect(calls[0]?.init.method).toBe("POST");
        expect(calls[0]?.init.body).toBe('{"name":"p"}');
        expect(headersOf(calls[0])).toMatchObject({ Authorization: "Bearer tok", "Content-Type": "application/json" });
    });

    test("an error status with an ApiError body is an `http` error", async () => {
        const { opts } = withFetch(() => json({ error: "busy", message: "a turn runs", details: { reasons: ["turn"] } }, 409));
        const e = (await request("DELETE", "/api/v1/analyses/a", {}, opts))._unsafeUnwrapErr();
        expect(e).toEqual({ type: "http", status: 409, body: { error: "busy", message: "a turn runs", details: { reasons: ["turn"] } } });
    });

    test("a body that is not JSON, or an error body that is not an ApiError, is `bad_json`", async () => {
        const text = withFetch(() => Promise.resolve(new Response("<html>proxy</html>", { status: 200 })));
        expect((await request("GET", "/x", {}, text.opts))._unsafeUnwrapErr()).toMatchObject({ type: "bad_json", status: 200, detail: "<html>proxy</html>" });

        const foreign = withFetch(() => json({ error: "made_up_code", message: "?" }, 400));
        expect((await request("GET", "/x", {}, foreign.opts))._unsafeUnwrapErr()).toMatchObject({ type: "bad_json", status: 400 });
    });

    test("no discovery file is `unreachable` before any fetch", async () => {
        const calls: string[] = [];
        const opts: ClientOpts = {
            discover: () => err({ type: "unreachable", reason: "not_running", baseUrl: BASE, cause: null }),
            fetch: (url) => {
                calls.push(url);
                return json({});
            },
        };
        expect((await request("GET", "/api/v1/server", {}, opts))._unsafeUnwrapErr()).toMatchObject({ type: "unreachable", reason: "not_running" });
        expect(calls).toEqual([]);
    });

    test("a refused connection is `unreachable`, and an abort of the caller is `aborted`", async () => {
        const refused = withFetch(() => Promise.reject(new Error("ECONNREFUSED")));
        expect((await request("GET", "/api/v1/server", {}, refused.opts))._unsafeUnwrapErr()).toMatchObject({
            type: "unreachable",
            reason: "connection_failed",
        });

        const controller = new AbortController();
        controller.abort();
        const aborted = withFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));
        expect((await request("GET", "/api/v1/server", { signal: controller.signal }, aborted.opts))._unsafeUnwrapErr()).toEqual({ type: "aborted" });
    });
});

describe("describeClientError", () => {
    test("an unreachable server names the command that starts one", () => {
        const refused: ClientError = { type: "unreachable", reason: "connection_failed", baseUrl: BASE, cause: null };
        const notRunning: ClientError = { type: "unreachable", reason: "not_running", baseUrl: BASE, cause: null };
        expect(describeClientError(refused)).toContain("`inflexa serve`");
        expect(describeClientError(notRunning)).toContain("`inflexa serve`");
    });

    test("an http error carries the message, the status, and the code of the body", () => {
        expect(describeClientError({ type: "http", status: 409, body: { error: "conflict", message: "The name is taken." } })).toBe(
            "The name is taken. (HTTP 409 conflict)",
        );
    });
});

describe("readSseFrames", () => {
    test("parses each `data:` frame, skips the open and ping comments, and joins a frame split across reads", async () => {
        const body = chunked([': open\n\n: ping\n\ndata: {"type":"a"', "}\n\n: ping\n\n", 'data: {"type":"b"}\r\n\r\n']);
        const frames = await collect(readSseFrames<{ type: string }>(body, BASE));
        expect(frames.map((f) => f._unsafeUnwrap())).toEqual([{ type: "a" }, { type: "b" }]);
    });

    test("a frame that is not JSON is a `bad_json` item, and the reader continues", async () => {
        const frames = await collect(readSseFrames<{ type: string }>(chunked(["data: not json\n\n", 'data: {"type":"ok"}\n\n']), BASE));
        expect(frames[0]?._unsafeUnwrapErr()).toMatchObject({ type: "bad_json" });
        expect(frames[1]?._unsafeUnwrap()).toEqual({ type: "ok" });
    });

    test("a broken connection is one `connection_failed` item, then the end", async () => {
        const broken = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"type":"a"}\n\n'));
                controller.error(new Error("socket closed"));
            },
        });
        const frames = await collect(readSseFrames<{ type: string }>(broken, BASE));
        expect(frames.at(-1)?._unsafeUnwrapErr()).toMatchObject({ type: "unreachable", reason: "connection_failed" });
    });
});

describe("streamRequest", () => {
    test("an open stream gives its frames, and asks for an event stream", async () => {
        const { opts, calls } = withFetch(() =>
            Promise.resolve(
                new Response(chunked(['data: {"type":"start"}\n\n', 'data: {"type":"finish"}\n\n']), { headers: { "Content-Type": "text/event-stream" } }),
            ),
        );
        const frames = (
            await streamRequest<{ type: string }>("POST", "/api/v1/analyses/a/chat", { body: { threadId: "t", message: "hi" } }, opts)
        )._unsafeUnwrap();
        expect((await collect(frames)).map((f) => f._unsafeUnwrap().type)).toEqual(["start", "finish"]);
        expect(headersOf(calls[0])).toMatchObject({ Accept: "text/event-stream" });
    });

    test("a refusal before the first frame is an `http` error on the result", async () => {
        const { opts } = withFetch(() => json({ error: "not_found", message: "No thread t in this analysis." }, 404));
        const e = (await streamRequest("POST", "/api/v1/analyses/a/chat", {}, opts))._unsafeUnwrapErr();
        expect(e).toMatchObject({ type: "http", status: 404, body: { error: "not_found" } });
    });
});
