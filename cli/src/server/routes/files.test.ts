import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

import type { ApiError } from "../../api/common.ts";
import { insertAnalysis, insertAnalysisInput, insertAnchor } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import { invalidateWorkspaceRoot, workspaceRootForAnalysisId } from "../../modules/analysis/output.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import { freshDb } from "../../test_support/db.ts";
import type { ServerEnv } from "../http.ts";
import { DEFAULT_FS_ROUTE_OPTS, fsRoutes, type FsRouteOpts } from "./fs.ts";

// The read route alone, with no credential check and no app: `app.test.ts` covers those. The analysis guard takes
// no real lock here, because a stub answers for it. Each `as` cast of a body below reads JSON that the route under
// test builds from the `ApiError` type.
const TEST_FS_ROUTE_OPTS: FsRouteOpts = { ...DEFAULT_FS_ROUTE_OPTS, acquireLock: () => ({ acquired: true }) };

function appWith(opts: Partial<FsRouteOpts> = {}): Hono<ServerEnv> {
    return fsRoutes({ ...TEST_FS_ROUTE_OPTS, ...opts });
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

/** `GET /read` of the route under test, with the path as given and `query` after it. */
function get(path: string, init?: RequestInit, query = ""): Promise<Response> | Response {
    return app.request(`/read?path=${encodeURIComponent(path)}${query}`, init);
}

/** `GET /read` of a path under the workspace root. */
function getAt(rel: string, init?: RequestInit, query = ""): Promise<Response> | Response {
    return get(join(root, rel), init, query);
}

/** Write a workspace file and give its absolute path. */
function workspaceFile(rel: string, content: string | Uint8Array): string {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    return abs;
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

describe("the path of a read", () => {
    test("a workspace file by its absolute path gives its bytes", async () => {
        const figure = workspaceFile("runs/R/A/figures/volcano.png", "png-bytes");
        const response = await get(figure, undefined, "&analysisId=ana-1");
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/png");
        expect(await response.text()).toBe("png-bytes");
    });

    test("a file of a declared input by its absolute path gives its bytes", async () => {
        writeFileSync(join(outside, "counts.csv"), "a,b\n1,2\n");
        declareInput(outside, true);
        const response = await get(join(outside, "counts.csv"), undefined, "&analysisId=ana-1");
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("a,b\n1,2\n");
    });

    test("a file outside the analysis gives its bytes, with and without the analysis id", async () => {
        writeFileSync(join(outside, "notes.txt"), "notes");
        for (const query of ["", "&analysisId=ana-1"]) {
            const response = await get(join(outside, "notes.txt"), undefined, query);
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("notes");
        }
    });

    test("a file that no analysis holds gives its bytes with no analysis id", async () => {
        const response = await get(workspaceFile("runs/R/A/figures/volcano.png", "png-bytes"));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("png-bytes");
    });

    test("a `..` segment is removed as text, also when it leaves the workspace", async () => {
        workspaceFile("runs/R/A/figures/volcano.png", "png-bytes");
        const inside = await get(`${root}/runs/R/A/output/../figures/volcano.png`);
        expect(inside.status).toBe(200);
        expect(await inside.text()).toBe("png-bytes");

        writeFileSync(join(root, "..", "sibling.txt"), "sibling");
        const leaving = await get(`${root}/runs/../../sibling.txt`);
        expect(leaving.status).toBe(200);
        expect(await leaving.text()).toBe("sibling");
        rmSync(join(root, "..", "sibling.txt"));
    });

    test("a link gives the bytes of its target with the content type of the requested name", async () => {
        writeFileSync(join(outside, "run7.csv"), "x\n");
        symlinkSync(join(outside, "run7.csv"), join(outside, "latest.csv"));
        const response = await get(join(outside, "latest.csv"));
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
        expect(await response.text()).toBe("x\n");

        symlinkSync(join(outside, "run7.csv"), join(outside, "latest.png"));
        expect((await get(join(outside, "latest.png"))).headers.get("Content-Type")).toBe("image/png");
    });

    test("a link to a folder gives the bytes of a file under it", async () => {
        writeFileSync(join(outside, "secret.txt"), "under-link");
        symlinkSync(outside, join(root, "linked"));
        const response = await get(join(root, "linked", "secret.txt"));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("under-link");
    });
});

describe("the errors of a bad request", () => {
    test("no path, an empty path, and a path with a NUL byte give 400", async () => {
        for (const response of [await app.request("/read"), await get(""), await get(`${root}/a\0b`)]) {
            const body = await expectError(response, 400, "validation_error");
            expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
        }
    });

    test("a relative path gives 400", async () => {
        workspaceFile("runs/R/A/figures/volcano.png", "png");
        const body = await expectError(await get("runs/R/A/figures/volcano.png"), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
    });

    test("a `download` value other than 1 gives 400", async () => {
        const file = workspaceFile("a.txt", "a");
        for (const query of ["&download=true", "&download="]) {
            const body = await expectError(await get(file, undefined, query), 400, "validation_error");
            expect(body.details).toEqual({ formErrors: [], fieldErrors: { download: ["must be 1"] } });
        }
    });

    test("an unknown analysis id gives 404 from the guard, and the route opens no file", async () => {
        const file = workspaceFile("a.txt", "a");
        let opened = 0;
        app = appWith({
            open: (path, flags) => {
                opened += 1;
                return open(path, flags);
            },
        });
        const body = await expectError(await get(file, undefined, "&analysisId=nope"), 404, "not_found");
        expect(body.message).toContain("nope");
        expect(opened).toBe(0);
    });

    test("an absent path gives 404", async () => {
        await expectError(await get(join(root, "runs/R/A/figures/absent.png")), 404, "not_found");
        await expectError(await get(`${root}/runs/R/A/figures/../../../../runs/R/gone.png`), 404, "not_found");
        await expectError(await get(join(outside, "absent.txt")), 404, "not_found");
    });

    test("a part of the path that is a file gives 404", async () => {
        const file = workspaceFile("a.txt", "a");
        await expectError(await get(join(file, "below.txt")), 404, "not_found");
    });

    test("a broken link and a loop of links give 404", async () => {
        symlinkSync(join(outside, "nowhere"), join(root, "broken"));
        symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
        symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
        await expectError(await get(join(root, "broken")), 404, "not_found");
        await expectError(await get(join(root, "loop-a")), 404, "not_found");
    });

    test("a folder gives 400", async () => {
        const body = await expectError(await get(join(root, "runs/R/A/figures")), 400, "validation_error");
        expect(body.message).toContain("file");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path is not a file."] } });
    });

    test("an open that fails with EOPNOTSUPP (macOS) or ENXIO (Linux), which a Unix socket gives, answers 400", async () => {
        const file = workspaceFile("a.csv", "abc");
        for (const code of ["EOPNOTSUPP", "ENXIO"]) {
            app = appWith({ open: () => Promise.reject(Object.assign(new Error(code), { code })) });
            await expectError(await get(file), 400, "validation_error");
        }
    });

    test.skipIf(process.getuid?.() === 0)("a failed real path gives 403 with the code of the operating system", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        writeFileSync(join(locked, "a.txt"), "a");
        chmodSync(locked, 0o000);
        try {
            const body = await expectError(await get(join(locked, "a.txt")), 403, "forbidden");
            expect(body.details).toEqual({ code: "EACCES" });
        } finally {
            chmodSync(locked, 0o755);
        }
    });

    test.skipIf(process.getuid?.() === 0)("a file whose mode is 000 gives 403 with the code of the operating system", async () => {
        const file = workspaceFile("closed.txt", "a");
        chmodSync(file, 0o000);
        try {
            const body = await expectError(await get(file), 403, "forbidden");
            expect(body.details).toEqual({ code: "EACCES" });
        } finally {
            chmodSync(file, 0o644);
        }
    });

    test("a FIFO gives 400 at once", async () => {
        const fifo = join(root, "pipe");
        expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
        await expectError(await get(fifo), 400, "validation_error");
    });
});

describe("the headers", () => {
    test("the content type comes from the requested name, with nosniff, the range unit, the length, and a tag", async () => {
        workspaceFile("de.csv", "a,b\n");
        workspaceFile("table.unknownext", "x");
        const csv = await getAt("de.csv");
        expect(csv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
        expect(csv.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(csv.headers.get("Accept-Ranges")).toBe("bytes");
        expect(csv.headers.get("Content-Length")).toBe("4");
        expect(csv.headers.get("Cache-Control")).toBe("no-cache");
        expect(csv.headers.get("ETag")).toMatch(/^"[0-9a-f]+-[0-9a-f]+-[0-9a-f]+"$/);
        expect(csv.headers.get("Content-Security-Policy")).toBeNull();
        expect(csv.headers.get("Content-Disposition")).toBeNull();
        expect((await getAt("table.unknownext")).headers.get("Content-Type")).toBe("application/octet-stream");
    });

    test("HTML, XHTML, SVG, and XML files get `Content-Security-Policy: sandbox`, and a PDF file does not", async () => {
        for (const [name, type] of [
            ["page.html", "text/html"],
            ["page.xhtml", "application/xhtml+xml"],
            ["figure.svg", "image/svg+xml"],
            ["data.xml", "application/xml"],
        ] as const) {
            workspaceFile(name, "<x/>");
            const response = await getAt(name);
            expect(response.headers.get("Content-Type")?.split(";")[0]).toBe(type);
            expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
        }
        workspaceFile("paper.pdf", "%PDF");
        expect((await getAt("paper.pdf")).headers.get("Content-Security-Policy")).toBeNull();
    });

    test("`download=1` adds an attachment with the last part of the requested path, also when the name is not ASCII", async () => {
        workspaceFile("runs/R/A/output/de.csv", "a\n");
        const plain = await getAt("runs/R/A/output/de.csv", undefined, "&download=1");
        expect(plain.headers.get("Content-Disposition")).toBe(`attachment; filename="de.csv"; filename*=UTF-8''de.csv`);
        workspaceFile('runs/R/A/output/résumé "q".csv', "a\n");
        const named = await getAt('runs/R/A/output/résumé "q".csv', undefined, "&download=1");
        expect(named.headers.get("Content-Disposition")).toBe(`attachment; filename="r_sum_ _q_.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22q%22.csv`);
    });
});

describe("the tag and the conditional request", () => {
    test("`If-None-Match` with the current tag, a list that holds it, a weak form, or `*` gives 304 with no body", async () => {
        workspaceFile("a.csv", "abc");
        const etag = (await getAt("a.csv")).headers.get("ETag") ?? "";
        for (const header of [etag, `"other", ${etag}`, `W/${etag}`, "*"]) {
            const response = await getAt("a.csv", { headers: { "If-None-Match": header } });
            expect(response.status).toBe(304);
            expect(response.headers.get("ETag")).toBe(etag);
            expect(await response.text()).toBe("");
        }
        expect((await getAt("a.csv", { headers: { "If-None-Match": '"other"' } })).status).toBe(200);
    });

    test("a changed file gives a new tag, and the old tag gives 200 with the new bytes", async () => {
        workspaceFile("a.csv", "abc");
        const old = (await getAt("a.csv")).headers.get("ETag") ?? "";
        workspaceFile("a.csv", "abcdef");
        const response = await getAt("a.csv", { headers: { "If-None-Match": old } });
        expect(response.status).toBe(200);
        expect(response.headers.get("ETag")).not.toBe(old);
        expect(await response.text()).toBe("abcdef");
    });

    test("a change of the time of the last change with the same size gives a new tag", async () => {
        workspaceFile("a.csv", "abc");
        const old = (await getAt("a.csv")).headers.get("ETag") ?? "";
        utimesSync(join(root, "a.csv"), new Date(1_000_000), new Date(1_000_000));
        expect((await getAt("a.csv")).headers.get("ETag")).not.toBe(old);
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
        const response = await getAt("big.bin", { headers: { Range: "bytes=0-99" } });
        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Range")).toBe("bytes 0-99/1000");
        expect(response.headers.get("Content-Length")).toBe("100");
        expect(await bytes(response)).toEqual([...body.subarray(0, 100)]);
    });

    test("an open range, a suffix range, and a `<last>` past the end give the part to the end", async () => {
        const open = await getAt("big.bin", { headers: { Range: "bytes=990-" } });
        expect(open.status).toBe(206);
        expect(open.headers.get("Content-Range")).toBe("bytes 990-999/1000");
        expect(await bytes(open)).toEqual([...body.subarray(990)]);

        const suffix = await getAt("big.bin", { headers: { Range: "bytes=-10" } });
        expect(suffix.headers.get("Content-Range")).toBe("bytes 990-999/1000");
        expect(await bytes(suffix)).toEqual([...body.subarray(990)]);

        const past = await getAt("big.bin", { headers: { Range: "bytes=995-5000" } });
        expect(past.headers.get("Content-Range")).toBe("bytes 995-999/1000");

        const longSuffix = await getAt("big.bin", { headers: { Range: "bytes=-5000" } });
        expect(longSuffix.headers.get("Content-Range")).toBe("bytes 0-999/1000");
    });

    test("`bytes=1000-` and a suffix of 0 give 416 `range_not_satisfiable` with `Content-Range: bytes */1000`", async () => {
        for (const range of ["bytes=1000-", "bytes=-0", "bytes=2000-3000"]) {
            const response = await getAt("big.bin", { headers: { Range: range } });
            await expectError(response, 416, "range_not_satisfiable");
            expect(response.headers.get("Content-Range")).toBe("bytes */1000");
        }
    });

    test("any range of an empty file gives 416", async () => {
        workspaceFile("empty.txt", "");
        const response = await getAt("empty.txt", { headers: { Range: "bytes=0-0" } });
        await expectError(response, 416, "range_not_satisfiable");
        expect(response.headers.get("Content-Range")).toBe("bytes */0");
        const full = await getAt("empty.txt");
        expect(full.status).toBe(200);
        expect(await full.text()).toBe("");
    });

    test("more than one range, a different unit, a bad form, and a `<last>` below `<first>` give 200 with the full file", async () => {
        for (const range of ["bytes=0-9,20-29", "items=0-9", "bytes=abc", "bytes=-", "bytes=50-10"]) {
            const response = await getAt("big.bin", { headers: { Range: range } });
            expect(response.status).toBe(200);
            expect(response.headers.get("Content-Range")).toBeNull();
            expect((await bytes(response)).length).toBe(1000);
        }
    });

    test("`If-Range` with the current tag keeps the range, and an old tag or a date gives 200 with the full file", async () => {
        const etag = (await getAt("big.bin")).headers.get("ETag") ?? "";
        const kept = await getAt("big.bin", { headers: { Range: "bytes=0-9", "If-Range": etag } });
        expect(kept.status).toBe(206);
        for (const ifRange of ['"old-tag"', "Wed, 21 Oct 2015 07:28:00 GMT"]) {
            const response = await getAt("big.bin", { headers: { Range: "bytes=0-9", "If-Range": ifRange } });
            expect(response.status).toBe(200);
            expect((await bytes(response)).length).toBe(1000);
        }
    });

    test("`If-None-Match` is tested before the range", async () => {
        const etag = (await getAt("big.bin")).headers.get("ETag") ?? "";
        const response = await getAt("big.bin", { headers: { Range: "bytes=0-9", "If-None-Match": etag } });
        expect(response.status).toBe(304);
    });
});

describe("the stream of the body", () => {
    /** The options that count the handles that the route opens and closes, and that run `wrap` on each open handle. */
    function tracked(wrap?: (handle: FileHandle) => void): { opts: Pick<FsRouteOpts, "open" | "chunkBytes">; opened: () => number; closed: () => number } {
        let opened = 0;
        let closed = 0;
        const opts: Pick<FsRouteOpts, "open" | "chunkBytes"> = {
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
        const response = await getAt("big.bin");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
        expect([opened(), closed()]).toEqual([1, 1]);
    });

    test("a range in the middle of a file streams the correct bytes", async () => {
        const content = Uint8Array.from({ length: 10_000 }, (_, i) => i % 253);
        workspaceFile("big.bin", content);
        app = appWith(tracked().opts);
        const response = await getAt("big.bin", { headers: { Range: "bytes=1500-4499" } });
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(content.subarray(1500, 4500));
    });

    test("a HEAD request gives the headers of the GET and no body, and the handle closes at once", async () => {
        workspaceFile("a.csv", "abc");
        const { opts, opened, closed } = tracked();
        app = appWith(opts);
        const response = await getAt("a.csv", { method: "HEAD" });
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
        const etag = (await getAt("a.csv", { method: "HEAD" })).headers.get("ETag") ?? "";
        expect((await getAt("a.csv", { headers: { "If-None-Match": etag } })).status).toBe(304);
        expect((await getAt("a.csv", { headers: { Range: "bytes=10-" } })).status).toBe(416);
        expect((await getAt("runs")).status).toBe(400);
        expect((await getAt("empty.txt")).status).toBe(200);
        expect([opened(), closed()]).toEqual([5, 5]);
    });

    test("a canceled body closes the handle", async () => {
        workspaceFile("big.bin", new Uint8Array(100_000));
        const { opts, opened, closed } = tracked();
        app = appWith(opts);
        const response = await getAt("big.bin");
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
        const response = await getAt("big.bin");
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
        const response = await getAt("big.bin");
        await expect(response.arrayBuffer()).rejects.toThrow("ended before");
        expect(closed()).toBe(1);
    });

    test("an open that fails with EACCES gives 403 with the code of the operating system", async () => {
        workspaceFile("a.csv", "abc");
        app = appWith({
            chunkBytes: 1024,
            open: () => Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })),
        });
        const body = await expectError(await getAt("a.csv"), 403, "forbidden");
        expect(body.details).toEqual({ code: "EACCES" });
    });

    test("the flags of the route make the open refuse a symbolic link in the last part, and the route answers 403", async () => {
        writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
        symlinkSync(join(outside, "secret.txt"), join(root, "late-link"));
        workspaceFile("a.csv", "abc");
        // A link that replaces the file between the test and the open: the open gets the link, not the real path.
        app = appWith({ chunkBytes: 1024, open: (_path, flags) => open(join(root, "late-link"), flags) });
        const body = await expectError(await getAt("a.csv"), 403, "forbidden");
        expect(JSON.stringify(body)).not.toContain("TOP-SECRET");
    });
});
