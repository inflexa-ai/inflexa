import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiError } from "../../api/common.ts";
import type { FolderList, HomeFolder } from "../../api/fs.ts";
import { entryDetails } from "../../lib/folder_listing.ts";
import { DEFAULT_FS_ROUTE_OPTS, fsRoutes } from "./fs.ts";

// The routes alone, with no app and no bearer check: `app.test.ts` covers those. Each `as` cast of a body below
// reads JSON that the route under test builds from the same `src/api/` type.
const routes = fsRoutes();

let root = "";

beforeEach(() => {
    // realpath so path assertions match the canonical paths of the listing (macOS /var -> /private/var).
    root = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-fs-routes-")));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function list(path: string, query = ""): Promise<Response> {
    return Promise.resolve(routes.request(`/list?path=${encodeURIComponent(path)}${query}`));
}

async function listBody(path: string, query = ""): Promise<FolderList> {
    const response = await list(path, query);
    expect(response.status).toBe(200);
    return (await response.json()) as FolderList;
}

/** The standard folder of the sort scenarios: the folder `beta`, the files `alpha.txt` and `Zeta.txt`, and the file `.env`. */
function seedSortFolder(): void {
    mkdirSync(join(root, "beta"));
    writeFileSync(join(root, "alpha.txt"), "12345");
    writeFileSync(join(root, "Zeta.txt"), "x");
    writeFileSync(join(root, ".env"), "x");
}

describe("GET /api/v1/fs/home", () => {
    test("gives the home folder of the server user", async () => {
        const response = await routes.request("/home");
        expect(response.status).toBe(200);
        expect((await response.json()) as HomeFolder).toEqual({ path: homedir() });
    });
});

describe("GET /api/v1/fs/list", () => {
    test("lists the folders first, then the files in case-insensitive order, and hides the dot-entries", async () => {
        seedSortFolder();
        const body = await listBody(root);
        expect(body.entries.map((e) => e.name)).toEqual(["beta", "alpha.txt", "Zeta.txt"]);
        expect(body).toMatchObject({ total: 3, page: 0, perPage: 100, hasMore: false });
        expect(body.folder.path).toBe(root);

        const [beta, alpha] = body.entries;
        expect(beta).toMatchObject({ kind: "folder", size: null, link: null, hidden: false, path: join(root, "beta") });
        expect(alpha).toMatchObject({ kind: "file", size: 5, readable: true, link: null, hidden: false });
        expect(typeof alpha?.mode).toBe("number");
        expect(new Date(alpha?.modifiedAt ?? "").toISOString()).toBe(alpha?.modifiedAt ?? "");
    });

    test("shows the hidden entries on request", async () => {
        seedSortFolder();
        const body = await listBody(root, "&hidden=true");
        expect(body.entries.map((e) => [e.name, e.hidden])).toEqual([
            ["beta", false],
            [".env", true],
            ["alpha.txt", false],
            ["Zeta.txt", false],
        ]);
        expect(body.total).toBe(4);
    });

    test("gives the stored target and the target kind of a link, and sorts the links after the folders", async () => {
        mkdirSync(join(root, "real"));
        mkdirSync(join(root, "z-folder"));
        symlinkSync("real", join(root, "data"));
        symlinkSync(join(root, "missing"), join(root, "gone"));
        const body = await listBody(root);
        expect(body.entries.map((e) => e.name)).toEqual(["real", "z-folder", "data", "gone"]);
        const [, , data, gone] = body.entries;
        expect(data).toMatchObject({ kind: "symlink", size: null, link: { target: "real", broken: false, targetKind: "folder" } });
        expect(gone).toEqual({
            name: "gone",
            path: join(root, "gone"),
            kind: "symlink",
            link: { target: join(root, "missing"), broken: true, targetKind: null },
            size: null,
            modifiedAt: null,
            mode: null,
            readable: null,
            writable: null,
            hidden: false,
        });
    });

    test("pages a large folder", async () => {
        for (let i = 0; i < 250; i += 1) writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
        const body = await listBody(root, "&page=1&perPage=100");
        expect(body.entries.map((e) => e.name)).toEqual(Array.from({ length: 100 }, (_, i) => `f${String(i + 100).padStart(3, "0")}.txt`));
        expect(body).toMatchObject({ total: 250, page: 1, perPage: 100, hasMore: true });
    });

    test("reads the facts of the entries of the returned page only", async () => {
        for (let i = 0; i < 250; i += 1) writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
        const read: string[] = [];
        const counted = fsRoutes({
            ...DEFAULT_FS_ROUTE_OPTS,
            entryDetails: (entry, identity) => {
                read.push(entry.name);
                return entryDetails(entry, identity);
            },
        });
        const response = await counted.request(`/list?path=${encodeURIComponent(root)}&page=2&perPage=100`);
        expect(((await response.json()) as FolderList).entries).toHaveLength(50);
        expect(read).toHaveLength(50);
        expect(read[0]).toBe("f200.txt");
    });

    test("gives the canonical path of a folder reached through a link", async () => {
        const real = join(root, "real");
        mkdirSync(real);
        writeFileSync(join(real, "f.txt"), "x");
        symlinkSync(real, join(root, "l"));
        const body = await listBody(join(root, "l"));
        expect(body.folder.path).toBe(real);
        expect(body.entries[0]?.path).toBe(join(real, "f.txt"));
        expect(body.folder.readable).toBe(true);
    });

    test("removes a `..` segment of the path as text", async () => {
        mkdirSync(join(root, "a"));
        mkdirSync(join(root, "b"));
        const body = await listBody(join(root, "a", "..", "b"));
        expect(body.folder.path).toBe(join(root, "b"));
    });

    test("lists the root of the disk, with no entry that carries the content of a file", async () => {
        const body = await listBody("/");
        expect(body.folder.path).toBe("/");
        for (const entry of body.entries) {
            expect(Object.keys(entry).sort()).toEqual(["hidden", "kind", "link", "mode", "modifiedAt", "name", "path", "readable", "size", "writable"]);
        }
    });
});

describe("GET /api/v1/fs/list errors", () => {
    async function expectError(response: Response, status: number, code: ApiError["error"]): Promise<ApiError> {
        expect(response.status).toBe(status);
        const body = (await response.json()) as ApiError;
        expect(body.error).toBe(code);
        return body;
    }

    test("400 `validation_error` for no path", async () => {
        const body = await expectError(await routes.request("/list"), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
    });

    test("400 `validation_error` for a relative path", async () => {
        const body = await expectError(await list("data"), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
    });

    test("400 `validation_error` for a path that holds a NUL byte", async () => {
        const body = await expectError(await list(`${root}/a\0b`), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
    });

    test("400 `validation_error` for a `hidden` value that is not `true` or `false`", async () => {
        const body = await expectError(await list(root, "&hidden=yes"), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { hidden: ["must be true or false"] } });
    });

    test("404 `not_found` for a folder that does not exist", async () => {
        await expectError(await list(join(root, "missing")), 404, "not_found");
    });

    test("400 `validation_error` for the path of a file", async () => {
        writeFileSync(join(root, "f.txt"), "x");
        const body = await expectError(await list(join(root, "f.txt")), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path is not a folder."] } });
    });

    test.skipIf(process.getuid?.() === 0)("403 `forbidden` for a folder with mode 000, with the cause", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
            const body = await expectError(await list(locked), 403, "forbidden");
            expect(body.message).toContain("EACCES");
            expect(body.details).toEqual({ code: "EACCES" });
        } finally {
            chmodSync(locked, 0o755);
        }
    });
});
