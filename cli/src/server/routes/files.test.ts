import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import type { ApiError } from "../../api/common.ts";
import { insertAnalysis, insertAnalysisInput, insertAnchor } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import { invalidateWorkspaceRoot, workspaceRootForAnalysisId } from "../../modules/analysis/output.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import { freshDb } from "../../test_support/db.ts";
import type { ServerEnv } from "../http.ts";
import { DEFAULT_FILE_ROUTE_OPTS, fileRoutes, type FileRouteOpts } from "./files.ts";

// The route alone, mounted at its path with no credential check and no analysis guard: `app.test.ts` covers those.
// Each `as` cast of a body below reads JSON that the route under test builds from the `ApiError` type.
function appWith(opts: FileRouteOpts = DEFAULT_FILE_ROUTE_OPTS): Hono<ServerEnv> {
    return new Hono<ServerEnv>().route("/api/v1/analyses/:analysisId/files", fileRoutes(opts));
}

let app = appWith();
let home = "";
let outside = "";
let root = "";

beforeEach(async () => {
    freshDb();
    // The workspace-root memo is process state that outlives freshDb().
    invalidateWorkspaceRoot();
    app = appWith();
    // realpath so the paths match the canonical paths of the route (macOS /var -> /private/var).
    home = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-files-route-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-files-outside-")));
    (await writeMarker(home, "A1"))._unsafeUnwrap();
    insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    insertAnalysis({ id: "ana-1", createdAt: 1, updatedAt: 1, name: asStr256("A"), slug: "a", anchorId: "A1", projectId: null })._unsafeUnwrap();
    root = (await workspaceRootForAnalysisId("ana-1"))._unsafeUnwrap();
    mkdirSync(join(root, "runs", "R", "A", "figures"), { recursive: true });
});

afterEach(() => {
    // The memo outlives this file: a root of a deleted folder must not reach the next test file.
    invalidateWorkspaceRoot();
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

function get(path: string, init?: RequestInit, query = ""): Promise<Response> | Response {
    return app.request(`/api/v1/analyses/ana-1/files?path=${encodeURIComponent(path)}${query}`, init);
}

/** Write a workspace file and give its path under the workspace. */
function workspaceFile(rel: string, content: string | Uint8Array): string {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    return rel;
}

async function expectError(response: Response, status: number, code: ApiError["error"]): Promise<ApiError> {
    expect(response.status).toBe(status);
    const body = (await response.json()) as ApiError;
    expect(body.error).toBe(code);
    return body;
}

function declareInput(path: string, isDir: boolean): void {
    insertAnalysisInput({ path, isDir, analysisId: "ana-1", anchorId: null })._unsafeUnwrap();
}

describe("the roots of the form of the path", () => {
    test("a relative path of a workspace file gives its bytes", async () => {
        workspaceFile("runs/R/A/figures/volcano.png", "png-bytes");
        const response = await get("runs/R/A/figures/volcano.png");
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("png-bytes");
    });

    test("a relative path with `..` that stays inside the workspace gives its bytes", async () => {
        workspaceFile("runs/R/A/figures/volcano.png", "png-bytes");
        const response = await get("runs/R/A/output/../figures/volcano.png");
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("png-bytes");
    });

    test("a relative path whose `..` leaves the workspace gives 403", async () => {
        // The file exists outside the workspace, next to it.
        writeFileSync(join(root, "..", "sibling.txt"), "sibling");
        await expectError(await get("../sibling.txt"), 403, "forbidden");
    });

    test("an absolute path inside a declared input folder gives its bytes", async () => {
        writeFileSync(join(outside, "counts.csv"), "a,b\n1,2\n");
        declareInput(outside, true);
        const response = await get(join(outside, "counts.csv"));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("a,b\n1,2\n");
    });

    test("the absolute path of a declared input that is one file gives its bytes", async () => {
        writeFileSync(join(outside, "run1.csv"), "x\n");
        writeFileSync(join(outside, "run2.csv"), "y\n");
        declareInput(join(outside, "run1.csv"), false);
        expect((await get(join(outside, "run1.csv"))).status).toBe(200);
        await expectError(await get(join(outside, "run2.csv")), 403, "forbidden");
    });

    test("an absolute path of a workspace file that no input holds gives 403", async () => {
        workspaceFile("runs/R/A/figures/volcano.png", "png-bytes");
        await expectError(await get(join(root, "runs/R/A/figures/volcano.png")), 403, "forbidden");
    });

    test("an absolute path of a workspace file that a declared input holds gives its bytes", async () => {
        workspaceFile("data/in.csv", "z\n");
        declareInput(join(root, "data"), true);
        expect((await get(join(root, "data", "in.csv"))).status).toBe(200);
    });

    test("a path outside each root gives 403, also for a relative path to a file of an input", async () => {
        writeFileSync(join(outside, "counts.csv"), "a\n");
        declareInput(outside, true);
        await expectError(await get("/etc/hosts"), 403, "forbidden");
        // A relative path reaches the workspace only, never an input.
        await expectError(await get(`../../../../..${outside}/counts.csv`), 403, "forbidden");
    });

    test("a symbolic link in the workspace that leaves the roots gives 403 and no byte of the target", async () => {
        writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
        symlinkSync(join(outside, "secret.txt"), join(root, "runs", "R", "A", "leak.txt"));
        const response = await get("runs/R/A/leak.txt");
        const body = await expectError(response, 403, "forbidden");
        expect(JSON.stringify(body)).not.toContain("TOP-SECRET");
    });

    test("a symbolic link to a folder outside the roots gives 403 for a file under it", async () => {
        writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
        symlinkSync(outside, join(root, "runs", "R", "A", "linked"));
        await expectError(await get("runs/R/A/linked/secret.txt"), 403, "forbidden");
    });

    test("a symbolic link that stays inside the workspace gives the bytes of its target", async () => {
        workspaceFile("runs/R/A/figures/volcano.png", "png-bytes");
        symlinkSync(join(root, "runs/R/A/figures/volcano.png"), join(root, "latest.png"));
        const response = await get("latest.png");
        expect(response.status).toBe(200);
        // The requested name gives the type.
        expect(response.headers.get("Content-Type")).toBe("image/png");
        expect(await response.text()).toBe("png-bytes");
    });
});

describe("the errors of a bad request", () => {
    test("no path, an empty path, and a path with a NUL byte give 400", async () => {
        await expectError(await app.request("/api/v1/analyses/ana-1/files"), 400, "validation_error");
        await expectError(await get(""), 400, "validation_error");
        await expectError(await get("runs/a\0b"), 400, "validation_error");
    });

    test("a `download` value other than 1 gives 400", async () => {
        workspaceFile("a.txt", "a");
        await expectError(await get("a.txt", undefined, "&download=true"), 400, "validation_error");
        await expectError(await get("a.txt", undefined, "&download="), 400, "validation_error");
    });

    test("a relative path of an analysis whose workspace cannot be located gives 409 with the message of the workspace error", async () => {
        const body = await expectError(await app.request("/api/v1/analyses/ghost/files?path=a.txt"), 409, "conflict");
        expect(body.message).toContain("no longer exists");
    });

    test.skipIf(process.getuid?.() === 0)("a workspace file of an analysis whose folder became read-only gives its bytes", async () => {
        workspaceFile("runs/R/A/figures/volcano.png", "png");
        chmodSync(home, 0o555);
        // The memo holds the root from the setup, while the folder was writable.
        invalidateWorkspaceRoot();
        try {
            const response = await get("runs/R/A/figures/volcano.png");
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("png");
        } finally {
            chmodSync(home, 0o755);
        }
    });

    test("an absent path inside the workspace gives 404", async () => {
        await expectError(await get("runs/R/A/figures/absent.png"), 404, "not_found");
        await expectError(await get("runs/R/A/figures/../../../../runs/R/gone.png"), 404, "not_found");
    });

    test("a broken link and a loop of links inside the workspace give 404", async () => {
        symlinkSync(join(outside, "nowhere"), join(root, "broken"));
        symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
        symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
        await expectError(await get("broken"), 404, "not_found");
        await expectError(await get("loop-a"), 404, "not_found");
    });

    test("an absent absolute path outside each input gives 403, and inside an input gives 404", async () => {
        declareInput(outside, true);
        await expectError(await get(join(home, "absent.txt")), 403, "forbidden");
        await expectError(await get(join(outside, "absent.txt")), 404, "not_found");
    });

    test("a folder gives 400", async () => {
        const body = await expectError(await get("runs/R/A/figures"), 400, "validation_error");
        expect(body.message).toContain("file");
    });

    test("an open that fails with EOPNOTSUPP (macOS) or ENXIO (Linux), which a Unix socket gives, answers 400", async () => {
        workspaceFile("a.csv", "abc");
        for (const code of ["EOPNOTSUPP", "ENXIO"]) {
            app = appWith({ chunkBytes: 1024, open: () => Promise.reject(Object.assign(new Error(code), { code })) });
            await expectError(await get("a.csv"), 400, "validation_error");
        }
    });

    test.skipIf(process.getuid?.() === 0)("a failed real path gives 403 with the code of the operating system", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        writeFileSync(join(locked, "a.txt"), "a");
        chmodSync(locked, 0o000);
        try {
            const body = await expectError(await get("locked/a.txt"), 403, "forbidden");
            expect(body.details).toEqual({ code: "EACCES" });
        } finally {
            chmodSync(locked, 0o755);
        }
    });

    test("a FIFO gives 400 at once", async () => {
        const fifo = join(root, "pipe");
        expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
        await expectError(await get("pipe"), 400, "validation_error");
    });
});

describe("the headers", () => {
    test("the content type comes from the requested name, with nosniff, the range unit, the length, and a tag", async () => {
        workspaceFile("de.csv", "a,b\n");
        workspaceFile("table.unknownext", "x");
        const csv = await get("de.csv");
        expect(csv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
        expect(csv.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(csv.headers.get("Accept-Ranges")).toBe("bytes");
        expect(csv.headers.get("Content-Length")).toBe("4");
        expect(csv.headers.get("Cache-Control")).toBe("no-cache");
        expect(csv.headers.get("ETag")).toMatch(/^"[0-9a-f]+-[0-9a-f]+-[0-9a-f]+"$/);
        expect(csv.headers.get("Content-Security-Policy")).toBeNull();
        expect(csv.headers.get("Content-Disposition")).toBeNull();
        expect((await get("table.unknownext")).headers.get("Content-Type")).toBe("application/octet-stream");
    });

    test("HTML, XHTML, SVG, and XML files get `Content-Security-Policy: sandbox`, and a PDF file does not", async () => {
        for (const [name, type] of [
            ["page.html", "text/html"],
            ["page.xhtml", "application/xhtml+xml"],
            ["figure.svg", "image/svg+xml"],
            ["data.xml", "application/xml"],
        ] as const) {
            workspaceFile(name, "<x/>");
            const response = await get(name);
            expect(response.headers.get("Content-Type")?.split(";")[0]).toBe(type);
            expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
        }
        workspaceFile("paper.pdf", "%PDF");
        expect((await get("paper.pdf")).headers.get("Content-Security-Policy")).toBeNull();
    });

    test("`download=1` adds an attachment with the last part of the requested path, also when the name is not ASCII", async () => {
        workspaceFile("runs/R/A/output/de.csv", "a\n");
        const plain = await get("runs/R/A/output/de.csv", undefined, "&download=1");
        expect(plain.headers.get("Content-Disposition")).toBe(`attachment; filename="de.csv"; filename*=UTF-8''de.csv`);
        workspaceFile('runs/R/A/output/résumé "q".csv', "a\n");
        const named = await get('runs/R/A/output/résumé "q".csv', undefined, "&download=1");
        expect(named.headers.get("Content-Disposition")).toBe(`attachment; filename="r_sum_ _q_.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22q%22.csv`);
    });
});

describe("the tag and the conditional request", () => {
    test("`If-None-Match` with the current tag, a list that holds it, a weak form, or `*` gives 304 with no body", async () => {
        workspaceFile("a.csv", "abc");
        const etag = (await get("a.csv")).headers.get("ETag") ?? "";
        for (const header of [etag, `"other", ${etag}`, `W/${etag}`, "*"]) {
            const response = await get("a.csv", { headers: { "If-None-Match": header } });
            expect(response.status).toBe(304);
            expect(response.headers.get("ETag")).toBe(etag);
            expect(await response.text()).toBe("");
        }
        expect((await get("a.csv", { headers: { "If-None-Match": '"other"' } })).status).toBe(200);
    });

    test("a changed file gives a new tag, and the old tag gives 200 with the new bytes", async () => {
        workspaceFile("a.csv", "abc");
        const old = (await get("a.csv")).headers.get("ETag") ?? "";
        workspaceFile("a.csv", "abcdef");
        const response = await get("a.csv", { headers: { "If-None-Match": old } });
        expect(response.status).toBe(200);
        expect(response.headers.get("ETag")).not.toBe(old);
        expect(await response.text()).toBe("abcdef");
    });

    test("a change of the time of the last change with the same size gives a new tag", async () => {
        workspaceFile("a.csv", "abc");
        const old = (await get("a.csv")).headers.get("ETag") ?? "";
        utimesSync(join(root, "a.csv"), new Date(1_000_000), new Date(1_000_000));
        expect((await get("a.csv")).headers.get("ETag")).not.toBe(old);
    });
});

describe("the range", () => {
    const body = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

    beforeEach(() => {
        workspaceFile("big.bin", body);
    });

    async function bytes(response: Response): Promise<number[]> {
        return [...new Uint8Array(await response.arrayBuffer())];
    }

    test("`bytes=0-99` gives 206 with the first 100 bytes", async () => {
        const response = await get("big.bin", { headers: { Range: "bytes=0-99" } });
        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe("bytes 0-99/1000");
        expect(response.headers.get("Content-Length")).toBe("100");
        expect(await bytes(response)).toEqual([...body.subarray(0, 100)]);
    });

    test("an open range, a suffix range, and a `<last>` past the end give the part to the end", async () => {
        const open = await get("big.bin", { headers: { Range: "bytes=990-" } });
        expect(open.status).toBe(206);
        expect(open.headers.get("Content-Range")).toBe("bytes 990-999/1000");
        expect(await bytes(open)).toEqual([...body.subarray(990)]);

        const suffix = await get("big.bin", { headers: { Range: "bytes=-10" } });
        expect(suffix.headers.get("Content-Range")).toBe("bytes 990-999/1000");
        expect(await bytes(suffix)).toEqual([...body.subarray(990)]);

        const past = await get("big.bin", { headers: { Range: "bytes=995-5000" } });
        expect(past.headers.get("Content-Range")).toBe("bytes 995-999/1000");

        const longSuffix = await get("big.bin", { headers: { Range: "bytes=-5000" } });
        expect(longSuffix.headers.get("Content-Range")).toBe("bytes 0-999/1000");
    });

    test("`bytes=1000-` and a suffix of 0 give 416 `range_not_satisfiable` with `Content-Range: bytes */1000`", async () => {
        for (const range of ["bytes=1000-", "bytes=-0", "bytes=2000-3000"]) {
            const response = await get("big.bin", { headers: { Range: range } });
            await expectError(response, 416, "range_not_satisfiable");
            expect(response.headers.get("Content-Range")).toBe("bytes */1000");
        }
    });

    test("any range of an empty file gives 416", async () => {
        workspaceFile("empty.txt", "");
        const response = await get("empty.txt", { headers: { Range: "bytes=0-0" } });
        await expectError(response, 416, "range_not_satisfiable");
        expect(response.headers.get("Content-Range")).toBe("bytes */0");
        const full = await get("empty.txt");
        expect(full.status).toBe(200);
        expect(await full.text()).toBe("");
    });

    test("more than one range, a different unit, a bad form, and a `<last>` below `<first>` give 200 with the full file", async () => {
        for (const range of ["bytes=0-9,20-29", "items=0-9", "bytes=abc", "bytes=-", "bytes=50-10"]) {
            const response = await get("big.bin", { headers: { Range: range } });
            expect(response.status).toBe(200);
            expect(response.headers.get("Content-Range")).toBeNull();
            expect((await bytes(response)).length).toBe(1000);
        }
    });

    test("`If-Range` with the current tag keeps the range, and an old tag or a date gives 200 with the full file", async () => {
        const etag = (await get("big.bin")).headers.get("ETag") ?? "";
        const kept = await get("big.bin", { headers: { Range: "bytes=0-9", "If-Range": etag } });
        expect(kept.status).toBe(206);
        for (const ifRange of ['"old-tag"', "Wed, 21 Oct 2015 07:28:00 GMT"]) {
            const response = await get("big.bin", { headers: { Range: "bytes=0-9", "If-Range": ifRange } });
            expect(response.status).toBe(200);
            expect((await bytes(response)).length).toBe(1000);
        }
    });

    test("`If-None-Match` is tested before the range", async () => {
        const etag = (await get("big.bin")).headers.get("ETag") ?? "";
        const response = await get("big.bin", { headers: { Range: "bytes=0-9", "If-None-Match": etag } });
        expect(response.status).toBe(304);
    });
});

describe("the stream of the body", () => {
    /** The options that count the handles that the route opens and closes, and that run `wrap` on each open handle. */
    function tracked(wrap?: (handle: FileHandle) => void): { opts: FileRouteOpts; opened: () => number; closed: () => number } {
        let opened = 0;
        let closed = 0;
        const opts: FileRouteOpts = {
            chunkBytes: 1024,
            open: async (path, flags) => {
                const handle = await open(path, flags);
                opened += 1;
                const close = handle.close.bind(handle);
                handle.close = async () => {
                    closed += 1;
                    await close();
                };
                wrap?.(handle);
                return handle;
            },
        };
        return { opts, opened: () => opened, closed: () => closed };
    }

    test("a file larger than the read buffer streams the correct bytes, and the handle closes one time", async () => {
        const content = Uint8Array.from({ length: 10_000 }, (_, i) => i % 253);
        workspaceFile("big.bin", content);
        const { opts, opened, closed } = tracked();
        app = appWith(opts);
        const response = await get("big.bin");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
        expect([opened(), closed()]).toEqual([1, 1]);
    });

    test("a range in the middle of a file streams the correct bytes", async () => {
        const content = Uint8Array.from({ length: 10_000 }, (_, i) => i % 253);
        workspaceFile("big.bin", content);
        app = appWith(tracked().opts);
        const response = await get("big.bin", { headers: { Range: "bytes=1500-4499" } });
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.subarray(1500, 4500));
    });

    test("a HEAD request gives the headers of the GET and no body, and the handle closes at once", async () => {
        workspaceFile("a.csv", "abc");
        const { opts, opened, closed } = tracked();
        app = appWith(opts);
        const response = await get("a.csv", { method: "HEAD" });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Length")).toBe("3");
        expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
        expect(await response.text()).toBe("");
        expect([opened(), closed()]).toEqual([1, 1]);
    });

    test("a 304, a 416, a folder, and a file of zero bytes close the handle at once", async () => {
        workspaceFile("a.csv", "abc");
        workspaceFile("empty.txt", "");
        const { opts, opened, closed } = tracked();
        app = appWith(opts);
        const etag = (await get("a.csv", { method: "HEAD" })).headers.get("ETag") ?? "";
        expect((await get("a.csv", { headers: { "If-None-Match": etag } })).status).toBe(304);
        expect((await get("a.csv", { headers: { Range: "bytes=10-" } })).status).toBe(416);
        expect((await get("runs")).status).toBe(400);
        expect((await get("empty.txt")).status).toBe(200);
        expect([opened(), closed()]).toEqual([5, 5]);
    });

    test("a canceled body closes the handle", async () => {
        workspaceFile("big.bin", new Uint8Array(100_000));
        const { opts, opened, closed } = tracked();
        app = appWith(opts);
        const response = await get("big.bin");
        // A 200 response with a non-empty file always has a body stream.
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel();
        expect([opened(), closed()]).toEqual([1, 1]);
    });

    test("a handle whose read fails ends the stream with an error and closes the handle", async () => {
        workspaceFile("big.bin", new Uint8Array(100_000));
        const { opts, closed } = tracked((handle) => {
            // The first read is the one that follows the status.
            // The cast is sound because the route calls `read` only to await its result, and a rejection is a valid result of the real method.
            handle.read = (() => Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }))) as unknown as FileHandle["read"];
        });
        app = appWith(opts);
        const response = await get("big.bin");
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Length")).toBe("100000");
        await expect(response.arrayBuffer()).rejects.toThrow("EIO");
        expect(closed()).toBe(1);
    });

    test("a file that gets shorter during the stream ends the body with an error", async () => {
        workspaceFile("big.bin", new Uint8Array(10_000));
        const { opts, closed } = tracked((handle) => {
            // The cast is sound because the route calls `read` with a buffer, an offset, a length, and a position, and the real method returns `{ bytesRead, buffer }` for that call.
            const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number; buffer: Uint8Array }>;
            let calls = 0;
            // The second read finds the end of the file. The cast is sound because the stub returns the `{ bytesRead, buffer }` shape of the real method, and the route reads only those fields.
            handle.read = (async (...args: unknown[]) => {
                calls += 1;
                // The route passes its buffer as the first argument of `read` (`fileBody` in files.ts), thus `args[0]` is a `Uint8Array`.
                return calls >= 2 ? { bytesRead: 0, buffer: args[0] as Uint8Array } : read(...args);
            }) as unknown as FileHandle["read"];
        });
        app = appWith(opts);
        const response = await get("big.bin");
        await expect(response.arrayBuffer()).rejects.toThrow("ended before");
        expect(closed()).toBe(1);
    });

    test("an open that fails with EACCES gives 403 with the code of the operating system", async () => {
        workspaceFile("a.csv", "abc");
        app = appWith({
            chunkBytes: 1024,
            open: () => Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })),
        });
        const body = await expectError(await get("a.csv"), 403, "forbidden");
        expect(body.details).toEqual({ code: "EACCES" });
    });

    test("the flags of the route make the open refuse a symbolic link in the last part, and the route answers 403", async () => {
        writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
        symlinkSync(join(outside, "secret.txt"), join(root, "late-link"));
        workspaceFile("a.csv", "abc");
        // A link that replaces the file between the test and the open: the open gets the link, not the real path.
        app = appWith({ chunkBytes: 1024, open: (_path, flags) => open(join(root, "late-link"), flags) });
        const body = await expectError(await get("a.csv"), 403, "forbidden");
        expect(JSON.stringify(body)).not.toContain("TOP-SECRET");
    });
});
