/**
 * The recorded-response suite of `web_fetch`.
 *
 * The guard tests run two ways. A real local server answers the hops whose
 * address the tool may really reach (`127.0.0.1`, `localhost`, `[::1]`), so
 * the literal path and the lookup path cross the real `node:http` client. Every
 * other address a test machine owns is guarded, thus the unguarded paths, the
 * redirects, the rebinding case, and the whole body suite run through an
 * injected hop that serves recorded bodies, with an injected lookup where a
 * test needs a controlled address set. No test reaches the network.
 */

import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { isIP, type AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";

import { makeSession } from "../../providers/__fixtures__/session.js";
import { AskRejectedError, UnavailableAsk, type AskApproval, type AskRequest } from "../approval/contract.js";
import type { ToolContext } from "../define-tool.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { HARNESS_USER_AGENT } from "../lib/api-utils.js";
import { type KeptToolOutput, type ToolOutputStore } from "../../loop/tool-output.js";
import { createReadToolOutputTool } from "../read-tool-output.js";
import {
    createWebFetchTool,
    htmlNestingDepth,
    type WebFetchHopRequest,
    type WebFetchHopRequestHandle,
    type WebFetchHopRequestOptions,
    type WebFetchHopResponse,
    type WebFetchLookup,
    type WebFetchOutput,
    type WebFetchToolDeps,
} from "./web-fetch.js";

interface RecordedHop {
    readonly status: number;
    readonly headers?: Record<string, string | string[] | undefined>;
    readonly body?: string | Buffer;
    readonly hang?: boolean;
    /** The request never answers, so only an abort or a timeout can end the hop. */
    readonly silent?: boolean;
}

class RecordedResponse extends EventEmitter implements WebFetchHopResponse {
    readonly statusCode: number | undefined;
    readonly headers: Record<string, string | string[] | undefined>;

    constructor(recording: RecordedHop) {
        super();
        this.statusCode = recording.status;
        this.headers = recording.headers ?? {};
        const body = recording.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(recording.body) ? recording.body : Buffer.from(recording.body);
        setImmediate(() => {
            this.emit("data", body);
            this.emit("end");
        });
    }

    destroy(): void {}
}

class RecordedRequest extends EventEmitter implements WebFetchHopRequestHandle {
    constructor(
        private readonly recording: RecordedHop,
        private readonly hostname: string,
        private readonly lookup: WebFetchHopRequestOptions["lookup"],
    ) {
        super();
    }

    end(): void {
        setImmediate(() => {
            if (this.recording.silent) return;
            if (this.recording.hang) {
                this.emit("timeout");
                return;
            }
            // The real client resolves a name through the lookup of the hop and never
            // resolves a literal host, so the recorded hop answers the same way.
            if (this.lookup === undefined || isIP(this.hostname) !== 0) {
                this.emit("response", new RecordedResponse(this.recording));
                return;
            }
            this.lookup(this.hostname, {}, (error, address) => {
                if (error) {
                    this.emit("error", error);
                    return;
                }
                if (typeof address !== "string") {
                    this.emit("error", new Error("the lookup answered an address list where one address was asked for"));
                    return;
                }
                this.emit("response", new RecordedResponse(this.recording));
            });
        });
    }

    destroy(error?: Error): void {
        if (error !== undefined) setImmediate(() => this.emit("error", error));
    }
}

interface HopLog {
    readonly urls: string[];
    readonly options: WebFetchHopRequestOptions[];
    readonly events: string[];
}

/** One recorded hop per URL string; `*` answers every URL that holds no entry. */
function recordedHopRequest(byUrl: Record<string, RecordedHop>, log: HopLog): WebFetchHopRequest {
    return (url, options) => {
        log.urls.push(url.toString());
        log.options.push(options);
        log.events.push(`hop:${url.hostname}${url.pathname}`);
        const recording = byUrl[url.toString()] ?? byUrl["*"] ?? { status: 200, body: Buffer.alloc(0) };
        return new RecordedRequest(recording, url.hostname, options.lookup);
    };
}

function emptyHopLog(): HopLog {
    return { urls: [], options: [], events: [] };
}

/** A lookup that answers a fixed list of addresses per call, in call order. */
function lookupAnswering(perCall: ReadonlyArray<readonly { address: string; family: number }[]>): WebFetchLookup {
    let call = 0;
    return (hostname, _options, callback) => {
        const addresses = perCall[Math.min(call, perCall.length - 1)]!;
        call += 1;
        setImmediate(() => callback(null, [...addresses]));
    };
}

const PUBLIC = [{ address: "93.184.216.34", family: 4 }] as const;
const PRIVATE = [{ address: "10.0.0.7", family: 4 }] as const;

interface AskLog {
    readonly requests: AskRequest[];
    readonly events: string[];
}

function askApproving(log: AskLog, reply: "once" | "always" = "once") {
    return async (request: AskRequest): Promise<AskApproval> => {
        log.requests.push(request);
        log.events.push("ask");
        return { kind: reply };
    };
}

function askDenying(log: AskLog, feedback?: string) {
    return async (request: AskRequest): Promise<AskApproval> => {
        log.requests.push(request);
        log.events.push("ask");
        throw new AskRejectedError(feedback);
    };
}

/** An ask that records standing grants by `grantKey`, the contract a surface implements. */
function askWithStandingGrants(): { ask: (request: AskRequest) => Promise<AskApproval>; prompts: AskRequest[] } {
    const grants = new Set<string>();
    const prompts: AskRequest[] = [];
    return {
        ask: async (request) => {
            if (request.grantKey !== undefined && grants.has(request.grantKey)) return { kind: "once" };
            grants.add(request.grantKey ?? "");
            prompts.push(request);
            return { kind: "always" };
        },
        prompts,
    };
}

function makeCtx(ask?: (request: AskRequest) => Promise<AskApproval>, signal?: AbortSignal): ToolContext {
    const deny = new UnavailableAsk();
    return {
        invocationId: "invoke-1",
        session: makeSession(),
        signal: signal ?? new AbortController().signal,
        emit: () => {},
        ask: ask ?? ((request) => deny.ask(request)),
    };
}

async function fetchUrl(url: string, deps: WebFetchToolDeps = {}, ctx: ToolContext = makeCtx()): Promise<WebFetchOutput> {
    const tool = createWebFetchTool(deps);
    const input = tool.inputSchema.parse({ url }) as Parameters<typeof tool.execute>[0];
    return (await tool.execute(input, ctx))._unsafeUnwrap() as WebFetchOutput;
}

/** A minimal PDF with one text line per page, the same builder shape the pdf-parse probe used. */
function buildPdf(pageCount: number): Buffer {
    const objects: string[] = ["1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj"];
    const kids = Array.from({ length: pageCount }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
    objects.push(`2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>endobj`, `3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`);
    for (let i = 0; i < pageCount; i++) {
        const content = `BT /F1 12 Tf 72 720 Td (Page ${i + 1} body text) Tj ET`;
        objects.push(
            `${4 + i * 2} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${5 + i * 2} 0 R/Resources<</Font<</F1 3 0 R>>>>>>endobj`,
            `${5 + i * 2} 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`,
        );
    }
    return Buffer.from(`%PDF-1.4\n${objects.join("\n")}\ntrailer<</Size ${3 + pageCount * 2}/Root 1 0 R>>`, "latin1");
}

interface LocalServer {
    readonly server: Server;
    readonly port: number;
    close(): Promise<void>;
}

async function startLocalServer(host: "127.0.0.1" | "localhost" | "::1"): Promise<LocalServer> {
    const server = createServer((request, response) => {
        if (request.url === "/gz") {
            response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
            response.end(gzipSync(Buffer.from("gzipped local body", "utf8")));
            return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("local server body");
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
        server,
        port,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
    };
}

/** Echoes whether the hop carried an Authorization header, which node derives from a user:pass URL. */
async function startAuthEchoServer(): Promise<LocalServer> {
    const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(request.headers.authorization === undefined ? "no authorization header" : `authorization:${request.headers.authorization}`);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    return {
        server,
        port,
        close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
    };
}

describe("web_fetch — the tool shape", () => {
    const tool = createWebFetchTool();

    it("runs in the step mode and names the URL of a call", () => {
        expect(tool.id).toBe("web_fetch");
        expect(tool.executionMode).toBe("step");
        expect(tool.describeCall?.({ url: "https://example.org/page" })).toBe("https://example.org/page");
    });

    it("bounds the URL input", () => {
        expect(tool.inputSchema.safeParse({}).success).toBe(false);
        expect(tool.inputSchema.safeParse({ url: "" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ url: `https://example.org/${"a".repeat(3000)}` }).success).toBe(false);
    });
});

describe("web_fetch — the guard", () => {
    it("fetches a public URL with no prompt", async () => {
        const hop = emptyHopLog();
        const ask: AskLog = { requests: [], events: hop.events };
        const output = await fetchUrl(
            "http://example.test/page",
            {
                hopRequest: recordedHopRequest(
                    { "http://example.test/page": { status: 200, headers: { "content-type": "text/plain" }, body: "public body" } },
                    hop,
                ),
                lookup: lookupAnswering([PUBLIC]),
            },
            makeCtx(askApproving(ask)),
        );

        expect(output).toMatchObject({ status: "ok", text: "public body", finalUrl: "http://example.test/page" });
        expect(ask.requests).toHaveLength(0);
        expect(hop.options[0]?.headers).toMatchObject({
            "user-agent": HARNESS_USER_AGENT,
            "Accept-Encoding": "identity",
            Accept: expect.stringContaining("text/html"),
        });
    });

    it("asks the name resolution for every address and answers the address shape the options request", async () => {
        const askedForAll: boolean[] = [];
        const hop = emptyHopLog();
        const output = await fetchUrl(
            "http://shape.test/a",
            {
                hopRequest: recordedHopRequest({ "http://shape.test/a": { status: 200, headers: { "content-type": "text/plain" }, body: "shaped" } }, hop),
                lookup: (_hostname, options, callback) => {
                    askedForAll.push(options.all === true);
                    setImmediate(() => callback(null, [...PUBLIC]));
                },
            },
            makeCtx(askApproving({ requests: [], events: hop.events })),
        );

        expect(output).toMatchObject({ status: "ok", text: "shaped" });
        expect(askedForAll).toEqual([true]);
    });

    it("asks before a guarded literal through a real local server, and fetches after an approval", async () => {
        const local = await startLocalServer("127.0.0.1");
        try {
            const ask: AskLog = { requests: [], events: [] };
            const url = `http://127.0.0.1:${local.port}/page`;
            const output = await fetchUrl(url, {}, makeCtx(askApproving(ask)));

            expect(output).toMatchObject({ status: "ok", text: "local server body", finalUrl: url });
            expect(ask.requests).toHaveLength(1);
            expect(ask.requests[0]).toMatchObject({ command: url, grantKey: `web_fetch:http://127.0.0.1:${local.port}` });
        } finally {
            await local.close();
        }
    });

    it("asks before a name that resolves to a guarded address, through the real lookup and a real local server", async () => {
        const local = await startLocalServer("127.0.0.1");
        try {
            const ask: AskLog = { requests: [], events: [] };
            const url = `http://localhost:${local.port}/page`;
            const output = await fetchUrl(url, {}, makeCtx(askApproving(ask)));

            expect(output).toMatchObject({ status: "ok", text: "local server body", finalUrl: url });
            expect(ask.requests).toHaveLength(1);
        } finally {
            await local.close();
        }
    });

    it("decodes a gzip body of a real local server through the real client", async () => {
        const local = await startLocalServer("127.0.0.1");
        try {
            const ask: AskLog = { requests: [], events: [] };
            const output = await fetchUrl(`http://127.0.0.1:${local.port}/gz`, {}, makeCtx(askApproving(ask)));

            expect(output).toMatchObject({ status: "ok", text: "gzipped local body" });
        } finally {
            await local.close();
        }
    });

    it("asks before the [::1] literal through a real local server", async () => {
        const local = await startLocalServer("::1");
        try {
            const ask: AskLog = { requests: [], events: [] };
            const url = `http://[::1]:${local.port}/page`;
            const output = await fetchUrl(url, {}, makeCtx(askApproving(ask)));

            expect(output).toMatchObject({ status: "ok", text: "local server body", finalUrl: url });
            expect(ask.requests).toHaveLength(1);
        } finally {
            await local.close();
        }
    });

    it("asks again on the next call after a once answer: no hop reuses a socket of an earlier call", async () => {
        const local = await startLocalServer("127.0.0.1");
        try {
            const ask: AskLog = { requests: [], events: [] };
            const url = `http://localhost:${local.port}/page`;
            const first = await fetchUrl(url, {}, makeCtx(askApproving(ask, "once")));
            const second = await fetchUrl(url, {}, makeCtx(askApproving(ask, "once")));

            expect(first).toMatchObject({ status: "ok", text: "local server body" });
            expect(second).toMatchObject({ status: "ok", text: "local server body" });
            expect(ask.requests).toHaveLength(2);
        } finally {
            await local.close();
        }
    });

    it("asks before a link-local, a private, and an IPv4-mapped literal, and a denial refuses each", async () => {
        const urls = ["http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/x", "http://[::ffff:169.254.169.254]/x"];
        for (const url of urls) {
            const ask: AskLog = { requests: [], events: [] };
            const output = await fetchUrl(url, { hopRequest: recordedHopRequest({}, emptyHopLog()) }, makeCtx(askDenying(ask, "not this host")));

            expect(output.status).toBe("refused");
            expect(ask.requests).toHaveLength(1);
            expect(output).toMatchObject({ feedback: "not this host" });
        }
    });

    it("returns a denied approval as a normal result with the user feedback", async () => {
        const ask: AskLog = { requests: [], events: [] };
        const output = await fetchUrl("http://127.0.0.1:9/x", {}, makeCtx(askDenying(ask, "use the mirror instead")));

        expect(output).toMatchObject({ status: "refused", feedback: "use the mirror instead" });
        expect(output.text).toContain("127.0.0.1");
    });

    it("refuses each guarded literal of the issue under UnavailableAsk, the deny-by-default ask", async () => {
        for (const url of ["http://127.0.0.1:9/x", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/x", "http://[::1]:9/x"]) {
            const output = await fetchUrl(url);

            expect(output.status).toBe("refused");
            expect(output).toMatchObject({ feedback: "approval is unavailable in this environment" });
        }
    });

    it("refuses a guarded name through the lookup path under UnavailableAsk", async () => {
        const output = await fetchUrl(
            "http://guarded-name.test/x",
            { hopRequest: recordedHopRequest({}, emptyHopLog()), lookup: lookupAnswering([PRIVATE]) },
            makeCtx(),
        );

        expect(output.status).toBe("refused");
    });

    it("asks on a rebinding name: a public first resolution passes, a private second resolution asks", async () => {
        const hop = emptyHopLog();
        const ask: AskLog = { requests: [], events: hop.events };
        const deps = {
            hopRequest: recordedHopRequest({ "http://rebind.test/a": { status: 200, headers: { "content-type": "text/plain" }, body: "first" } }, hop),
            lookup: lookupAnswering([PUBLIC, PRIVATE]),
        };

        const first = await fetchUrl("http://rebind.test/a", deps, makeCtx(askApproving(ask)));
        expect(first).toMatchObject({ status: "ok", text: "first" });
        expect(ask.requests).toHaveLength(0);

        const second = await fetchUrl("http://rebind.test/a", deps, makeCtx(askDenying(ask)));
        expect(second.status).toBe("refused");
        expect(ask.requests).toHaveLength(1);
    });

    it("asks before any connect of a resolution whose second address is guarded, then re-sends the hop", async () => {
        const hop = emptyHopLog();
        const ask: AskLog = { requests: [], events: hop.events };
        const output = await fetchUrl(
            "http://twofaces.test/a",
            {
                hopRequest: recordedHopRequest(
                    { "http://twofaces.test/a": { status: 200, headers: { "content-type": "text/plain" }, body: "after approval" } },
                    hop,
                ),
                lookup: lookupAnswering([[...PUBLIC, { address: "192.168.5.5", family: 4 }]]),
            },
            makeCtx(askApproving(ask)),
        );

        expect(output).toMatchObject({ status: "ok", text: "after approval" });
        expect(ask.requests).toHaveLength(1);
        expect(hop.urls).toEqual(["http://twofaces.test/a", "http://twofaces.test/a"]);
        expect(hop.events).toEqual(["hop:twofaces.test/a", "ask", "hop:twofaces.test/a"]);
    });

    it("scopes an always answer to the origin: the same origin asks nothing, a different origin asks again", async () => {
        const hop = emptyHopLog();
        const { ask, prompts } = askWithStandingGrants();
        const deps = { hopRequest: recordedHopRequest({ "*": { status: 200, body: "ok" } }, hop) };
        const ctx = () => makeCtx(ask);

        await fetchUrl("http://10.0.0.1:81/a", deps, ctx());
        await fetchUrl("http://10.0.0.1:81/b", deps, ctx());
        await fetchUrl("http://10.0.0.2:81/a", deps, ctx());

        expect(prompts).toHaveLength(2);
        expect(prompts.map((request) => request.grantKey)).toEqual(["web_fetch:http://10.0.0.1:81", "web_fetch:http://10.0.0.2:81"]);
    });

    it("names the origin an always answer approves in the detail of the ask", async () => {
        const ask: AskLog = { requests: [], events: [] };
        await fetchUrl("http://10.0.0.1:81/a", { hopRequest: recordedHopRequest({}, emptyHopLog()) }, makeCtx(askDenying(ask)));

        expect(ask.requests[0]?.detail).toContain("http://10.0.0.1:81");
    });

    it("sends no Authorization header for a user:pass URL, and the ask names no password", async () => {
        const local = await startAuthEchoServer();
        try {
            const ask: AskLog = { requests: [], events: [] };
            const output = await fetchUrl(`http://user:secret@127.0.0.1:${local.port}/page`, {}, makeCtx(askApproving(ask)));

            expect(output).toMatchObject({ status: "ok", text: "no authorization header", finalUrl: `http://127.0.0.1:${local.port}/page` });
            expect(ask.requests[0]?.command).not.toContain("secret");
        } finally {
            await local.close();
        }
    });

    it("hops with a URL that holds no credentials", async () => {
        const hop = emptyHopLog();
        const output = await fetchUrl("http://user:pass@example.test/page", {
            hopRequest: recordedHopRequest({ "http://example.test/page": { status: 200, headers: { "content-type": "text/plain" }, body: "clean" } }, hop),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output).toMatchObject({ status: "ok", text: "clean", finalUrl: "http://example.test/page" });
        expect(hop.urls).toEqual(["http://example.test/page"]);
    });

    it("re-asks for a redirect to the same host on a different port, because the origin key holds the port", async () => {
        const hop = emptyHopLog();
        const ask: AskLog = { requests: [], events: hop.events };
        const output = await fetchUrl(
            "http://10.0.0.1:81/a",
            {
                hopRequest: recordedHopRequest(
                    {
                        "http://10.0.0.1:81/a": { status: 302, headers: { location: "http://10.0.0.1:82/b" } },
                        "http://10.0.0.1:82/b": { status: 200, headers: { "content-type": "text/plain" }, body: "other port" },
                    },
                    hop,
                ),
            },
            makeCtx(askApproving(ask)),
        );

        expect(output).toMatchObject({ status: "ok", text: "other port", finalUrl: "http://10.0.0.1:82/b" });
        expect(ask.requests.map((request) => request.grantKey)).toEqual(["web_fetch:http://10.0.0.1:81", "web_fetch:http://10.0.0.1:82"]);
    });

    it("asks before a redirect to a guarded address, and follows only after an approval", async () => {
        const hop = emptyHopLog();
        const ask: AskLog = { requests: [], events: hop.events };
        const output = await fetchUrl(
            "http://public.test/start",
            {
                hopRequest: recordedHopRequest(
                    {
                        "http://public.test/start": { status: 302, headers: { location: "http://169.254.169.254/target" } },
                        "http://169.254.169.254/target": { status: 200, headers: { "content-type": "text/plain" }, body: "redirect target body" },
                    },
                    hop,
                ),
                lookup: lookupAnswering([PUBLIC]),
            },
            makeCtx(askApproving(ask)),
        );

        expect(output).toMatchObject({ status: "ok", text: "redirect target body", finalUrl: "http://169.254.169.254/target" });
        expect(ask.requests).toHaveLength(1);
    });

    it("refuses a scheme that is not http or https, and an invalid URL", async () => {
        expect(await fetchUrl("file:///etc/passwd")).toMatchObject({ status: "unsupported_scheme", scheme: "file:" });
        expect(await fetchUrl("ftp://example.org/x")).toMatchObject({ status: "unsupported_scheme", scheme: "ftp:" });
        expect(await fetchUrl("not a url")).toMatchObject({ status: "invalid_url" });
    });

    it("returns an HTTP error status as a normal result", async () => {
        const output = await fetchUrl("https://example.test/gone", {
            hopRequest: recordedHopRequest({ "https://example.test/gone": { status: 500, body: "boom" } }, emptyHopLog()),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output).toMatchObject({ status: "http_error", httpStatus: 500 });
    });

    it("follows five redirects and refuses the sixth with a result that names the limit", async () => {
        const chain = (count: number): Record<string, RecordedHop> => {
            const byUrl: Record<string, RecordedHop> = {};
            for (let i = 0; i < count; i++) byUrl[`http://example.test/r${i}`] = { status: 302, headers: { location: `http://example.test/r${i + 1}` } };
            byUrl[`http://example.test/r${count}`] = { status: 200, headers: { "content-type": "text/plain" }, body: "chain end" };
            return byUrl;
        };
        const deps = (byUrl: Record<string, RecordedHop>): WebFetchToolDeps => ({
            hopRequest: recordedHopRequest(byUrl, emptyHopLog()),
            lookup: lookupAnswering([PUBLIC]),
        });

        const five = await fetchUrl("http://example.test/r0", deps(chain(5)));
        expect(five).toMatchObject({ status: "ok", text: "chain end", finalUrl: "http://example.test/r5" });

        const six = await fetchUrl("http://example.test/r0", deps(chain(6)));
        expect(six.status).toBe("redirect_limit");
        expect(six.status === "redirect_limit" && six.text).toContain("5");
    });

    it("destroys the hop and fails normally on a hop timeout, with the 120 s per-hop bound", async () => {
        const hop = emptyHopLog();
        const output = await fetchUrl("http://slow.test/x", {
            hopRequest: recordedHopRequest({ "http://slow.test/x": { status: 200, hang: true } }, hop),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output.status).toBe("request_failed");
        expect(output.status === "request_failed" && output.detail).toContain("timed out");
        expect(hop.options[0]?.timeoutMs).toBe(120_000);
    });

    it("propagates an abort of the turn", async () => {
        const controller = new AbortController();
        const promise = fetchUrl(
            "http://silent.test/x",
            { hopRequest: recordedHopRequest({ "http://silent.test/x": { status: 200, silent: true } }, emptyHopLog()), lookup: lookupAnswering([PUBLIC]) },
            makeCtx(undefined, controller.signal),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.abort();

        await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    });
});

describe("web_fetch — the byte limits", () => {
    const FIVE_MB = 5 * 1024 * 1024;

    function textBody(deps: Record<string, unknown>): Record<string, RecordedHop> {
        return { "http://example.test/body": { status: 200, headers: { "content-type": "text/plain" }, ...deps } };
    }

    it("reads a body of exactly the limit", async () => {
        const body = "a".repeat(FIVE_MB);
        const output = await fetchUrl("http://example.test/body", {
            hopRequest: recordedHopRequest(textBody({ body, headers: { "content-type": "text/plain", "content-length": String(FIVE_MB) } }), emptyHopLog()),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output).toMatchObject({ status: "ok", contentType: "text/plain" });
    });

    it("refuses a body past the limit while it is read, with no Content-Length", async () => {
        const output = await fetchUrl("http://example.test/body", {
            hopRequest: recordedHopRequest(textBody({ body: "a".repeat(FIVE_MB + 1) }), emptyHopLog()),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output).toMatchObject({ status: "body_too_large", limitBytes: FIVE_MB });
    });

    it("refuses at once on a Content-Length over the limit", async () => {
        const overText = await fetchUrl("http://example.test/body", {
            hopRequest: recordedHopRequest(textBody({ headers: { "content-type": "text/plain", "content-length": String(FIVE_MB + 1) } }), emptyHopLog()),
            lookup: lookupAnswering([PUBLIC]),
        });
        expect(overText).toMatchObject({ status: "body_too_large", limitBytes: FIVE_MB });

        const overUnknown = await fetchUrl("http://example.test/body", {
            hopRequest: recordedHopRequest(
                textBody({ headers: { "content-type": "application/octet-stream", "content-length": String(FIVE_MB + 1) } }),
                emptyHopLog(),
            ),
            lookup: lookupAnswering([PUBLIC]),
        });
        expect(overUnknown).toMatchObject({ status: "body_too_large", limitBytes: FIVE_MB, contentType: "application/octet-stream" });
    });

    it("counts a gzip body after decoding: a body that decodes past the limit is refused", async () => {
        const compressed = gzipSync(Buffer.from("b".repeat(FIVE_MB + 1024), "utf8"));
        const output = await fetchUrl("http://example.test/body", {
            hopRequest: recordedHopRequest(
                textBody({
                    body: compressed,
                    headers: { "content-type": "text/plain", "content-encoding": "gzip", "content-length": String(compressed.length) },
                }),
                emptyHopLog(),
            ),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output).toMatchObject({ status: "body_too_large", limitBytes: FIVE_MB });
    });

    it("decodes gzip, deflate, and brotli when a server sends them anyway", async () => {
        const cases: ReadonlyArray<[string, Buffer, string]> = [
            ["gzip", gzipSync(Buffer.from("decoded gzip body", "utf8")), "decoded gzip body"],
            ["deflate", deflateSync(Buffer.from("decoded deflate body", "utf8")), "decoded deflate body"],
            ["br", brotliCompressSync(Buffer.from("decoded brotli body", "utf8")), "decoded brotli body"],
        ];
        for (const [encoding, body, plain] of cases) {
            const output = await fetchUrl("http://example.test/body", {
                hopRequest: recordedHopRequest(
                    { "http://example.test/body": { status: 200, headers: { "content-type": "text/plain", "content-encoding": encoding }, body } },
                    emptyHopLog(),
                ),
                lookup: lookupAnswering([PUBLIC]),
            });
            expect(output).toMatchObject({ status: "ok", text: plain });
        }
    });

    it("reads a gzip body whose encoded length passes the limit while the decoded body stays under it", async () => {
        const decoded = Buffer.alloc(FIVE_MB - 64);
        let state = 0x9e3779b9;
        for (let i = 0; i + 4 <= decoded.length; i += 4) {
            state = (state ^ ((state << 13) >>> 0)) >>> 0;
            state = (state ^ (state >>> 17)) >>> 0;
            state = (state ^ ((state << 5) >>> 0)) >>> 0;
            decoded.writeUInt32BE(state, i);
        }
        const compressed = gzipSync(decoded);
        expect(compressed.length).toBeGreaterThan(FIVE_MB);

        const output = await fetchUrl("http://example.test/body", {
            hopRequest: recordedHopRequest(
                textBody({
                    body: compressed,
                    headers: { "content-type": "text/plain", "content-encoding": "gzip", "content-length": String(compressed.length) },
                }),
                emptyHopLog(),
            ),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output).toMatchObject({ status: "ok", contentType: "text/plain" });
    });

    it("refuses an HTML body over the limit while it is read, through the injected request client", async () => {
        const html = `<!doctype html><html><body>${"word ".repeat(Math.ceil((FIVE_MB + 1024) / 5))}</body></html>`;
        const output = await fetchUrl("http://example.test/page", {
            hopRequest: recordedHopRequest(
                { "http://example.test/page": { status: 200, headers: { "content-type": "text/html" }, body: html } },
                emptyHopLog(),
            ),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output).toMatchObject({ status: "body_too_large", limitBytes: FIVE_MB, contentType: "text/html" });
    });

    it("refuses an oversized PDF under the 20 MB PDF limit", async () => {
        const output = await fetchUrl("http://example.test/body", {
            hopRequest: recordedHopRequest(
                { "http://example.test/body": { status: 200, headers: { "content-type": "application/pdf", "content-length": String(20 * 1024 * 1024 + 1) } } },
                emptyHopLog(),
            ),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output).toMatchObject({ status: "body_too_large", limitBytes: 20 * 1024 * 1024, contentType: "application/pdf" });
    });
});

describe("web_fetch — the extractors", () => {
    const HTML_PAGE =
        "<!doctype html><html><head><title>TP53 - example</title></head><body>" +
        "<nav>site navigation</nav>" +
        '<article><h1>The TP53 gene</h1><p>Some <b>bold</b> text with a <a href="https://example.org/x">link</a>.</p><p>Second paragraph of the article.</p></article>' +
        "</body></html>";

    function extractorDeps(byUrl: Record<string, RecordedHop>): WebFetchToolDeps {
        return { hopRequest: recordedHopRequest(byUrl, emptyHopLog()), lookup: lookupAnswering([PUBLIC]) };
    }

    it("turns an HTML page into Markdown", async () => {
        const output = await fetchUrl(
            "http://example.test/page",
            extractorDeps({ "http://example.test/page": { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: HTML_PAGE } }),
        );

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.contentType).toBe("text/html");
        expect(output.text).toContain("The TP53 gene");
        expect(output.text).toContain("**bold**");
        expect(output.text).toContain("[link](https://example.org/x)");
        expect(output.text).not.toContain("site navigation");
    });

    it("falls back to the body text when the article extraction gives nothing", async () => {
        const output = await fetchUrl(
            "http://example.test/page",
            extractorDeps({
                "http://example.test/page": {
                    status: 200,
                    headers: { "content-type": "text/html" },
                    body: "<html><body><div>just a few plain words</div></body></html>",
                },
            }),
        );

        expect(output).toMatchObject({ status: "ok", text: "just a few plain words" });
    });

    it("refuses a pathologically nested page as unextractable instead of stalling the parse", async () => {
        const output = await fetchUrl(
            "http://example.test/page",
            extractorDeps({
                "http://example.test/page": {
                    status: 200,
                    headers: { "content-type": "text/html" },
                    body: `${"<div>".repeat(10_000)}deep page`,
                },
            }),
        );

        expect(output).toMatchObject({ status: "unextractable" });
        if (output.status !== "unextractable") return;
        expect(output.detail).toContain("nests deeper than");
    });

    it("extracts a page nested within the bound, with markup-looking attribute values and comments", async () => {
        const nested = `${'<div class="level">'.repeat(50)}<article><h1>deep but legal</h1><p>text of the article</p></article>${"</div>".repeat(50)}`;
        const tricky = `<html><body><div title="</div>"><!-- <div> -->${nested}</div></body></html>`;
        const output = await fetchUrl(
            "http://example.test/page",
            extractorDeps({ "http://example.test/page": { status: 200, headers: { "content-type": "text/html" }, body: tricky } }),
        );

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.text).toContain("deep but legal");
    });

    it("keeps a long unclosed list flat, so list length never trips the nesting bound", async () => {
        const list = `<html><body><ul>${"<li>item".repeat(2_000)}</ul></body></html>`;
        const output = await fetchUrl(
            "http://example.test/page",
            extractorDeps({ "http://example.test/page": { status: 200, headers: { "content-type": "text/html" }, body: list } }),
        );

        expect(output.status).toBe("ok");
        expect(htmlNestingDepth(list)).toBeLessThanOrEqual(10);
    });

    it("measures raw text and scripts as one level, not as markup structure", () => {
        const withScript = `<html><body><script>if (1 < 2) { document.write("</div>"); }</script><p>after</p></body></html>`;
        expect(htmlNestingDepth(withScript)).toBe(3);
        expect(htmlNestingDepth(`${"<section>".repeat(513)}x`)).toBe(513);
    });

    it("turns a PDF into text, whole when it holds at most 100 pages", async () => {
        const output = await fetchUrl(
            "http://example.test/doc.pdf",
            extractorDeps({ "http://example.test/doc.pdf": { status: 200, headers: { "content-type": "application/pdf" }, body: buildPdf(2) } }),
        );

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.contentType).toBe("application/pdf");
        expect(output.text).toContain("Page 1 body text");
        expect(output.text).toContain("Page 2 body text");
        expect(output.pdfCut).toBeUndefined();
    });

    it("reads at most the first 100 pages of a PDF and names the cut", async () => {
        const output = await fetchUrl(
            "http://example.test/doc.pdf",
            extractorDeps({ "http://example.test/doc.pdf": { status: 200, headers: { "content-type": "application/pdf" }, body: buildPdf(101) } }),
        );

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.pdfCut).toEqual({ totalPages: 101, pagesRead: 100 });
        expect(output.text).toContain("Page 100 body text");
        expect(output.text).not.toContain("Page 101 body text");
    });

    it("passes a text body and a JSON body through", async () => {
        const text = await fetchUrl(
            "http://example.test/a",
            extractorDeps({ "http://example.test/a": { status: 200, headers: { "content-type": "text/csv" }, body: "col1,col2\n1,2\n" } }),
        );
        expect(text).toMatchObject({ status: "ok", text: "col1,col2\n1,2" });

        const json = await fetchUrl(
            "http://example.test/b",
            extractorDeps({ "http://example.test/b": { status: 200, headers: { "content-type": "application/json" }, body: '{"gene": "TP53"}' } }),
        );
        expect(json).toMatchObject({ status: "ok", text: '{"gene": "TP53"}' });
    });

    it("names the content type of a body it cannot extract, and sniffs no magic bytes", async () => {
        const pdfBytes = buildPdf(1);
        const octet = await fetchUrl(
            "http://example.test/a",
            extractorDeps({ "http://example.test/a": { status: 200, headers: { "content-type": "application/octet-stream" }, body: pdfBytes } }),
        );
        expect(octet).toMatchObject({ status: "unextractable", contentType: "application/octet-stream" });
        expect(octet.status === "unextractable" && octet.text).toContain("application/octet-stream");

        const image = await fetchUrl(
            "http://example.test/b",
            extractorDeps({ "http://example.test/b": { status: 200, headers: { "content-type": "image/png" }, body: "not really a png" } }),
        );
        expect(image).toMatchObject({ status: "unextractable", contentType: "image/png" });
    });
});

describe("web_fetch — the returned text and the kept remainder", () => {
    const LONG_TEXT = Array.from({ length: 40_000 }, (_, i) => String(i % 10)).join("");

    function memoryStore(rows: Map<string, KeptToolOutput>): ToolOutputStore {
        return {
            put: (output) => {
                rows.set(`${output.analysisId}:${output.ref}`, output);
                return okAsync(undefined);
            },
            get: (analysisId, ref) => okAsync(rows.get(`${analysisId}:${ref}`) ?? null),
        };
    }

    function longTextDeps(store?: ToolOutputStore): WebFetchToolDeps {
        return {
            hopRequest: recordedHopRequest(
                { "http://example.test/long": { status: 200, headers: { "content-type": "text/plain" }, body: LONG_TEXT } },
                emptyHopLog(),
            ),
            lookup: lookupAnswering([PUBLIC]),
            ...(store !== undefined ? { toolOutputStore: store } : {}),
        };
    }

    it("returns the first 30,000 characters and keeps the remainder for read_tool_output through the store", async () => {
        const rows = new Map<string, KeptToolOutput>();
        const output = await fetchUrl("http://example.test/long", longTextDeps(memoryStore(rows)), makeCtx());

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.text).toBe(LONG_TEXT.slice(0, 30_000));
        expect(output.totalLength).toBe(40_000);
        expect(output.cut).toBe(true);
        expect(output.finalUrl).toBe("http://example.test/long");
        expect(output.remainderNotKept).toBeUndefined();

        const ref = output.kept?.ref;
        expect(ref).toBeDefined();
        expect(output.kept?.keptLength).toBe(40_000);
        const kept = ref !== undefined ? rows.get(`analysis-001:${ref}`) : undefined;
        expect(kept).toMatchObject({ analysisId: "analysis-001", toolName: "web_fetch", toolCallId: "invoke-1", content: LONG_TEXT, totalLength: 40_000 });

        const reader = createReadToolOutputTool(memoryStore(rows));
        const readToolCtx = makeToolContext().ctx;
        const parsedInput = reader.inputSchema.parse({ ref, offset: 30_000, limit: 10_000 });
        const page = (await reader.execute(parsedInput as Parameters<typeof reader.execute>[0], readToolCtx))._unsafeUnwrap() as Record<string, unknown>;
        expect(page).toMatchObject({ status: "ok", ref, offset: 30_000, keptLength: 40_000, more: false });
        expect(page.text).toBe(LONG_TEXT.slice(30_000, 40_000));
    });

    it("records the threadId of the session when the scope carries one", async () => {
        const rows = new Map<string, KeptToolOutput>();
        const ctx: ToolContext = {
            ...makeCtx(),
            session: makeSession({ scope: { kind: "analysis", analysisId: "analysis-001", threadId: "thread-77" } }),
        };
        const output = await fetchUrl("http://example.test/long", longTextDeps(memoryStore(rows)), ctx);

        expect(output.status).toBe("ok");
        const ref = output.status === "ok" ? output.kept?.ref : undefined;
        expect(rows.get(`analysis-001:${ref}`)).toMatchObject({ threadId: "thread-77" });
    });

    it("says that the remainder is not kept when no store is present", async () => {
        const output = await fetchUrl("http://example.test/long", longTextDeps());

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.cut).toBe(true);
        expect(output.kept).toBeUndefined();
        expect(output.remainderNotKept).toBe(true);
    });

    it("keeps the remainder through the store even when the serialized result forces a smaller cut", async () => {
        const rows = new Map<string, KeptToolOutput>();
        const quoted = '"'.repeat(60_000);
        const output = await fetchUrl(
            "http://example.test/long",
            {
                hopRequest: recordedHopRequest(
                    { "http://example.test/long": { status: 200, headers: { "content-type": "text/plain" }, body: quoted } },
                    emptyHopLog(),
                ),
                lookup: lookupAnswering([PUBLIC]),
                toolOutputStore: memoryStore(rows),
            },
            makeCtx(),
        );

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.cut).toBe(true);
        expect(output.totalLength).toBe(60_000);
        expect(output.remainderNotKept).toBeUndefined();
        expect(JSON.stringify(output).length).toBeLessThanOrEqual(32 * 1024 - 512);
        const ref = output.kept?.ref;
        expect(ref).toBeDefined();
        const kept = ref !== undefined ? rows.get(`analysis-001:${ref}`) : undefined;
        expect(kept).toMatchObject({ toolName: "web_fetch", content: quoted, totalLength: 60_000 });

        const reader = createReadToolOutputTool(memoryStore(rows));
        const parsedInput = reader.inputSchema.parse({ ref, offset: output.text.length, limit: 1_000 });
        const page = (await reader.execute(parsedInput as Parameters<typeof reader.execute>[0], makeToolContext().ctx))._unsafeUnwrap() as Record<
            string,
            unknown
        >;
        expect(page).toMatchObject({ status: "ok", ref, keptLength: 60_000, more: true });
        expect(page.text).toBe(quoted.slice(output.text.length, output.text.length + 1_000));
    });

    it("degrades to remainderNotKept when the store put fails, instead of failing the fetch", async () => {
        const failing: ToolOutputStore = {
            put: () => errAsync({ type: "store-down" }),
            get: () => okAsync(null),
        };
        const output = await fetchUrl("http://example.test/long", longTextDeps(failing), makeCtx());

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.cut).toBe(true);
        expect(output.kept).toBeUndefined();
        expect(output.remainderNotKept).toBe(true);
    });

    it("shrinks its own cut when the serialized result would cross the loop cap", async () => {
        const quoted = '"'.repeat(60_000);
        const output = await fetchUrl("http://example.test/long", {
            hopRequest: recordedHopRequest(
                { "http://example.test/long": { status: 200, headers: { "content-type": "text/plain" }, body: quoted } },
                emptyHopLog(),
            ),
            lookup: lookupAnswering([PUBLIC]),
        });

        expect(output.status).toBe("ok");
        if (output.status !== "ok") return;
        expect(output.totalLength).toBe(60_000);
        expect(JSON.stringify(output).length).toBeLessThanOrEqual(32 * 1024 - 512);
    });
});
