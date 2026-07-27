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
