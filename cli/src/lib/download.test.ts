import { describe, expect, test, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { declaredContentLength, downloadToFile, type DownloadProgress } from "./download.ts";

const roots: string[] = [];
function root(): string {
    const p = mkdtempSync(join(tmpdir(), "inflexa-download-"));
    roots.push(p);
    return p;
}
afterEach(() => {
    for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

const URL_OK = "https://example.test/file.bin";
function sha(body: string): string {
    return createHash("sha256").update(body).digest("hex");
}

/** Local rather than `Promise.sleep`: the global extensions load from the CLI entry point, which a test process never runs. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Offline upstream: serves `body`, optionally as an error status, a post-redirect url, or with a content-length header. */
function serve(
    body: string,
    opts?: { status?: number; url?: string; contentLength?: boolean },
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return async () => {
        if (opts?.status !== undefined && opts.status >= 400) return new Response("missing", { status: opts.status, statusText: "Not Found" });
        const headers: Record<string, string> = {};
        if (opts?.contentLength) headers["content-length"] = String(Buffer.byteLength(body));
        const response = new Response(body, Object.keys(headers).length > 0 ? { headers } : undefined);
        if (opts?.url) Object.defineProperty(response, "url", { value: opts.url });
        return response;
    };
}

describe("downloadToFile", () => {
    test("streams an https url to dest and returns bytes + sha256, leaving no .part", async () => {
        const dest = join(root(), "out.bin");
        const body = "hello geo world";
        const result = await downloadToFile(URL_OK, dest, { fetch: serve(body) });
        expect(result._unsafeUnwrap()).toEqual({ bytes: Buffer.byteLength(body), sha256: sha(body) });
        expect(readFileSync(dest, "utf8")).toBe(body);
        expect(existsSync(`${dest}.part`)).toBe(false);
    });

    test("refuses a redirect to a non-https location and writes nothing", async () => {
        const dest = join(root(), "out.bin");
        const result = await downloadToFile(URL_OK, dest, { fetch: serve("x", { url: "http://downgraded.test/file.bin" }) });
        expect(result._unsafeUnwrapErr().type).toBe("insecure_redirect");
        expect(existsSync(dest)).toBe(false);
        expect(existsSync(`${dest}.part`)).toBe(false);
    });

    test("reports an http error as http_failed and writes nothing", async () => {
        const dest = join(root(), "out.bin");
        const result = await downloadToFile(URL_OK, dest, { fetch: serve("", { status: 404 }) });
        expect(result._unsafeUnwrapErr().type).toBe("http_failed");
        expect(existsSync(dest)).toBe(false);
    });

    test("emits started/bytes/completed progress, bytes summing to the file size", async () => {
        const dest = join(root(), "out.bin");
        const body = "abcdefgh";
        const events: DownloadProgress[] = [];
        await downloadToFile(URL_OK, dest, { fetch: serve(body, { contentLength: true }), onProgress: (e) => events.push(e) });
        expect(events[0]).toEqual({ type: "started", declaredBytes: Buffer.byteLength(body) });
        const bytes = events.filter((e) => e.type === "bytes").reduce((n, e) => n + (e.type === "bytes" ? e.bytes : 0), 0);
        expect(bytes).toBe(Buffer.byteLength(body));
        expect(events.at(-1)).toEqual({ type: "completed", bytes: Buffer.byteLength(body) });
    });

    test("cancels the body of a response it refuses, so the socket is not held", async () => {
        // A rejected response still owns its connection until the body is drained or cancelled. Both
        // refusal arms are covered because they return from different points and each could forget.
        for (const refused of [{ status: 503, statusText: "Service Unavailable" } as const, { url: "http://downgraded.test/f" } as const]) {
            let cancelled = 0;
            const stream = new ReadableStream({
                start: (c) => c.enqueue(new TextEncoder().encode("body")),
                cancel: () => void (cancelled += 1),
            });
            const response = "url" in refused ? new Response(stream) : new Response(stream, refused);
            if ("url" in refused) Object.defineProperty(response, "url", { value: refused.url });
            const result = await downloadToFile(URL_OK, join(root(), "out.bin"), { fetch: async () => response });
            expect(result.isErr()).toBe(true);
            expect(cancelled).toBe(1);
        }
    });

    test("cancels a retried response's body before the attempt that needs its connection", async () => {
        let cancelled = 0;
        let calls = 0;
        const dest = join(root(), "out.bin");
        const result = await downloadToFile(URL_OK, dest, {
            retry: { attempts: 2, baseMs: 0, shouldRetry: (status) => status === 429 },
            fetch: async () => {
                calls += 1;
                if (calls > 1) return new Response("payload");
                return new Response(
                    new ReadableStream({
                        start: (c) => c.enqueue(new TextEncoder().encode("slow down")),
                        cancel: () => void (cancelled += 1),
                    }),
                    { status: 429, statusText: "Too Many Requests" },
                );
            },
        });
        expect(result.isOk()).toBe(true);
        expect(readFileSync(dest, "utf8")).toBe("payload");
        expect(cancelled).toBe(1);
    });

    test("ends a body that stops moving as stalled, and writes nothing", async () => {
        // The failure the watch exists for: the socket is open, the promise is pending, and the upstream
        // sent one chunk and then died. Nothing but the gap between chunks can tell this from slow work.
        const dest = join(root(), "out.bin");
        const stream = new ReadableStream({
            start: (c) => c.enqueue(new TextEncoder().encode("first")),
        });
        const result = await downloadToFile(URL_OK, dest, { fetch: async () => new Response(stream), livenessWindowMs: 40 });
        expect(result._unsafeUnwrapErr().type).toBe("stalled");
        expect(existsSync(dest)).toBe(false);
    });

    test("runs past the window for as long as bytes keep arriving", async () => {
        // The half that a wall-clock deadline gets wrong: this transfer outlives its own window twice over
        // and is healthy throughout, which is exactly the multi-gigabyte download the bound must not cut.
        const dest = join(root(), "out.bin");
        const stream = new ReadableStream({
            async start(c) {
                for (const part of ["a", "b", "c", "d", "e"]) {
                    await sleep(20);
                    c.enqueue(new TextEncoder().encode(part));
                }
                c.close();
            },
        });
        const result = await downloadToFile(URL_OK, dest, { fetch: async () => new Response(stream), livenessWindowMs: 50 });
        expect(result.isOk()).toBe(true);
        expect(readFileSync(dest, "utf8")).toBe("abcde");
    });

    test("ends a request that never answers as stalled, and spends no further attempt on it", async () => {
        // An expired window is the upstream's whole allowance, so the retry schedule stops rather than
        // spending three more windows on a host that has already said nothing for one.
        let calls = 0;
        const result = await downloadToFile(URL_OK, join(root(), "out.bin"), {
            retry: { attempts: 3, baseMs: 0, shouldRetry: () => true },
            livenessWindowMs: 40,
            fetch: async (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    calls += 1;
                    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                }),
        });
        expect(result._unsafeUnwrapErr().type).toBe("stalled");
        expect(calls).toBe(1);
    });

    test("a progress observer throw never aborts the transfer", async () => {
        const dest = join(root(), "out.bin");
        const result = await downloadToFile(URL_OK, dest, {
            fetch: serve("payload"),
            onProgress: () => {
                throw new Error("observer boom");
            },
        });
        expect(result.isOk()).toBe(true);
        expect(readFileSync(dest, "utf8")).toBe("payload");
    });
});

describe("declaredContentLength", () => {
    test("returns the length for an identity-encoded response", () => {
        expect(declaredContentLength(new Response("abc", { headers: { "content-length": "3" } }))).toBe(3);
    });

    test("returns undefined when the length sits beside a non-identity encoding", () => {
        expect(declaredContentLength(new Response("abc", { headers: { "content-length": "3", "content-encoding": "gzip" } }))).toBeUndefined();
    });

    test("returns undefined when no length is declared", () => {
        expect(declaredContentLength(new Response("abc"))).toBeUndefined();
    });
});
