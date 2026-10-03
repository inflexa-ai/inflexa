import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import type { ChatFrame } from "@inflexa-ai/harness/contracts/index.js";

import { TURN_ID_HEADER } from "../api/conversation.ts";
import type { ClientOpts } from "./api.ts";
import { createChatTurn, fetchThread, fetchThreads } from "./conversation.ts";

const BASE = "http://127.0.0.1:8436";

/** Client opts with a fixed endpoint, whose fetch gives `respond()` and records each URL. */
function withFetch(respond: () => Response): { opts: ClientOpts; urls: string[] } {
    const urls: string[] = [];
    return {
        opts: {
            discover: () => ok({ baseUrl: BASE, token: "tok" }),
            fetch: (url) => {
                urls.push(url);
                return Promise.resolve(respond());
            },
        },
        urls,
    };
}

function sse(frames: unknown[], headers: Record<string, string>): Response {
    const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    return new Response(body, { headers: { "Content-Type": "text/event-stream", ...headers } });
}

describe("createChatTurn", () => {
    test("gives the turn id of the response header and the frames of the stream", async () => {
        const finish: ChatFrame = { type: "finish", source: { agentId: "chat", callPath: ["chat"] } };
        const { opts, urls } = withFetch(() => sse([finish], { [TURN_ID_HEADER]: "turn-1" }));
        const stream = (await createChatTurn("a 1", { threadId: "t1", message: "hi" }, opts))._unsafeUnwrap();
        expect(stream.turnId).toBe("turn-1");
        const frames = [];
        for await (const item of stream.frames) frames.push(item._unsafeUnwrap());
        expect(frames).toEqual([finish]);
        expect(urls).toEqual([`${BASE}/api/v1/analyses/a%201/chat`]);
    });

    test("a stream with no turn id is a `bad_json` error, because no client could abort the turn", async () => {
        const { opts } = withFetch(() => sse([], {}));
        const e = (await createChatTurn("a1", { threadId: "t1", message: "hi" }, opts))._unsafeUnwrapErr();
        expect(e).toMatchObject({ type: "bad_json", detail: `the chat stream has no ${TURN_ID_HEADER} header` });
    });

    test("a refusal before the turn opens is the `http` error of its JSON body", async () => {
        const { opts } = withFetch(() => Response.json({ error: "not_found", message: "Thread not found." }, { status: 404 }));
        const e = (await createChatTurn("a1", { threadId: "t1", message: "hi" }, opts))._unsafeUnwrapErr();
        expect(e).toEqual({ type: "http", status: 404, body: { error: "not_found", message: "Thread not found." } });
    });
});

describe("fetchThread", () => {
    test("an absent thread (404) is `null`, not an error", async () => {
        const { opts } = withFetch(() => Response.json({ error: "not_found", message: "Thread not found." }, { status: 404 }));
        expect((await fetchThread("a1", "t1", opts))._unsafeUnwrap()).toBeNull();
    });

    test("a different failure stays an error", async () => {
        const { opts } = withFetch(() => Response.json({ error: "unavailable", message: "starting", details: { phase: "starting" } }, { status: 503 }));
        expect((await fetchThread("a1", "t1", opts))._unsafeUnwrapErr()).toMatchObject({ type: "http", status: 503 });
    });
});

describe("fetchThreads", () => {
    test("sends each filter that is set as a query value", async () => {
        const { opts, urls } = withFetch(() => Response.json({ threads: [], total: 0, page: 1, perPage: 5, hasMore: false }));
        (await fetchThreads("a1", { type: "report", parentThreadId: "p1", includeArchived: true }, { page: 1, perPage: 5 }, opts))._unsafeUnwrap();
        expect(urls).toEqual([`${BASE}/api/v1/analyses/a1/threads?page=1&perPage=5&type=report&parentThreadId=p1&includeArchived=true`]);
    });
});
