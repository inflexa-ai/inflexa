import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertAnalysis, insertAnalysisInput, insertAnchor } from "../../db/primary_mutation.ts";
import { getAnchor } from "../../db/primary_query.ts";
import { asStr256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import { writeMarker } from "../anchor/marker.ts";
import { canRead, canWrite, classifyRealPath, inputReadRoots, workspaceReadRoot, type ReadRoot, type Roots } from "./boundary.ts";
import { invalidateWorkspaceRoot } from "./output.ts";

const roots: Roots = {
    writable: ["/work/out"],
    readable: ["/work/out", "/data/src"],
};

describe("canWrite", () => {
    test("allows the writable root itself and its descendants", () => {
        expect(canWrite(roots, "/work/out")).toBe(true);
        expect(canWrite(roots, "/work/out/report.md")).toBe(true);
    });

    test("rejects a sibling that merely shares a path prefix (boundary-safe: /work/outside ∉ /work/out)", () => {
        expect(canWrite(roots, "/work/outside")).toBe(false);
    });

    test("rejects a readable-but-not-writable path and anything outside every root", () => {
        expect(canWrite(roots, "/data/src")).toBe(false);
        expect(canWrite(roots, "/etc/passwd")).toBe(false);
    });
});

describe("canRead", () => {
    test("allows any readable root and its descendants", () => {
        expect(canRead(roots, "/data/src/lib.ts")).toBe(true);
        expect(canRead(roots, "/work/out/report.md")).toBe(true);
    });

    test("rejects a prefix-sharing sibling and outside paths (boundary-safe: /data/source ∉ /data/src)", () => {
        expect(canRead(roots, "/data/source")).toBe(false);
        expect(canRead(roots, "/elsewhere")).toBe(false);
    });
});

describe("classifyRealPath", () => {
    let dir = "";
    let root: ReadRoot;

    beforeEach(() => {
        // realpath so the roots are canonical on macOS (/var -> /private/var).
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-real-path-")));
        mkdirSync(join(dir, "root", "sub"), { recursive: true });
        mkdirSync(join(dir, "outside"));
        writeFileSync(join(dir, "root", "sub", "a.txt"), "a");
        writeFileSync(join(dir, "outside", "secret.txt"), "s");
        root = { text: join(dir, "root"), canonical: join(dir, "root") };
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("a file inside a root is `in` with its real path, and a path equal to a root that is one file is `in`", async () => {
        const inside = (await classifyRealPath([root], join(dir, "root", "sub", "a.txt")))._unsafeUnwrap();
        expect(inside).toEqual({ type: "in", realPath: join(dir, "root", "sub", "a.txt") });
        const oneFile: ReadRoot = { text: join(dir, "outside", "secret.txt"), canonical: join(dir, "outside", "secret.txt") };
        expect((await classifyRealPath([oneFile], oneFile.text))._unsafeUnwrap()).toEqual({ type: "in", realPath: oneFile.text });
    });

    test("a symbolic link that leaves the roots is `outside`, and a link that stays inside is `in` with the target", async () => {
        symlinkSync(join(dir, "outside", "secret.txt"), join(dir, "root", "leak.txt"));
        symlinkSync(join(dir, "root", "sub", "a.txt"), join(dir, "root", "ok.txt"));
        expect((await classifyRealPath([root], join(dir, "root", "leak.txt")))._unsafeUnwrap()).toEqual({ type: "outside" });
        expect((await classifyRealPath([root], join(dir, "root", "ok.txt")))._unsafeUnwrap()).toEqual({
            type: "in",
            realPath: join(dir, "root", "sub", "a.txt"),
        });
    });

    test("a sibling that shares the prefix of a root is `outside`", async () => {
        mkdirSync(join(dir, "rootbeer"));
        writeFileSync(join(dir, "rootbeer", "x.txt"), "x");
        expect((await classifyRealPath([root], join(dir, "rootbeer", "x.txt")))._unsafeUnwrap()).toEqual({ type: "outside" });
    });

    test("a root whose text form differs from its canonical form tests the real path against the canonical form", async () => {
        symlinkSync(join(dir, "root"), join(dir, "alias"));
        const aliased: ReadRoot = { text: join(dir, "alias"), canonical: join(dir, "root") };
        const verdict = (await classifyRealPath([aliased], join(dir, "alias", "sub", "a.txt")))._unsafeUnwrap();
        expect(verdict).toEqual({ type: "in", realPath: join(dir, "root", "sub", "a.txt") });
    });

    test("an absent path, a broken link, and a loop of links are `absent`", async () => {
        symlinkSync(join(dir, "nowhere"), join(dir, "root", "broken"));
        symlinkSync(join(dir, "root", "loop-b"), join(dir, "root", "loop-a"));
        symlinkSync(join(dir, "root", "loop-a"), join(dir, "root", "loop-b"));
        for (const name of ["gone.txt", "broken", "loop-a"]) {
            expect((await classifyRealPath([root], join(dir, "root", name)))._unsafeUnwrap()).toEqual({ type: "absent", insideAsText: true });
        }
        // A file used as a folder gives ENOTDIR.
        expect((await classifyRealPath([root], join(dir, "root", "sub", "a.txt", "x")))._unsafeUnwrap()).toEqual({ type: "absent", insideAsText: true });
    });

    test("an absent path is inside a root as text only when its `..` segments resolve inside", async () => {
        expect((await classifyRealPath([root], join(dir, "root", "sub", "..", "gone.txt")))._unsafeUnwrap()).toEqual({ type: "absent", insideAsText: true });
        expect((await classifyRealPath([root], join(dir, "root", "..", "outside", "gone.txt")))._unsafeUnwrap()).toEqual({
            type: "absent",
            insideAsText: false,
        });
        expect((await classifyRealPath([root], join(dir, "elsewhere", "gone.txt")))._unsafeUnwrap()).toEqual({ type: "absent", insideAsText: false });
    });

    test("a failure other than an absent path is the error with its cause", async () => {
        // A NUL byte is refused by `node:fs` before any lookup, and it is not a missing path.
        const error = (await classifyRealPath([root], join(dir, "root", "a\0b")))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: "io_failed", op: "classifyRealPath", cause: { code: "ERR_INVALID_ARG_VALUE" } });
    });

    test("no root gives `outside` with no disk read", async () => {
        expect((await classifyRealPath([], join(dir, "root", "sub", "a.txt")))._unsafeUnwrap()).toEqual({ type: "outside" });
    });
});

describe("the roots of a read", () => {
    const created: string[] = [];

    beforeEach(() => {
        freshDb();
        invalidateWorkspaceRoot();
    });

    afterEach(() => {
        for (const dir of created) rmSync(dir, { recursive: true, force: true });
        created.length = 0;
    });

    function tmp(): string {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-read-roots-")));
        created.push(dir);
        return dir;
    }

    async function seedAnalysis(home: string): Promise<void> {
        (await writeMarker(home, "A1"))._unsafeUnwrap();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis({ id: "ana-1", createdAt: 1, updatedAt: 1, name: asStr256("A"), slug: "a", anchorId: "A1", projectId: null })._unsafeUnwrap();
    }

    test("the input roots are the anchored input and the absolute input, and an input with a lost anchor is not a root", async () => {
        const home = tmp();
        const elsewhere = tmp();
        mkdirSync(join(home, "data"));
        await seedAnalysis(home);
        insertAnalysisInput({ path: "data", isDir: true, analysisId: "ana-1", anchorId: "A1" })._unsafeUnwrap();
        insertAnalysisInput({ path: elsewhere, isDir: true, analysisId: "ana-1", anchorId: null })._unsafeUnwrap();

        const roots = (await inputReadRoots("ana-1"))._unsafeUnwrap();
        expect(roots.map((r) => r.canonical).sort()).toEqual([join(home, "data"), elsewhere].sort());
        for (const r of roots) expect(r.text).toBe(r.canonical);
    });

    test("the lookups write no anchor sighting", async () => {
        const home = tmp();
        await seedAnalysis(home);
        insertAnalysisInput({ path: ".", isDir: true, analysisId: "ana-1", anchorId: "A1" })._unsafeUnwrap();

        (await inputReadRoots("ana-1"))._unsafeUnwrap();
        (await workspaceReadRoot("ana-1"))._unsafeUnwrap();
        expect(getAnchor("A1")._unsafeUnwrap()?.lastSeen).toBe(1);
    });

    test("the workspace root has a text form and a canonical form, and the lookup makes no folder", async () => {
        const home = tmp();
        await seedAnalysis(home);
        const root = (await workspaceReadRoot("ana-1"))._unsafeUnwrap();
        expect(root.text.startsWith(home)).toBe(true);
        expect(root.canonical).toBe(root.text);
        // The workspace folder is made by `ensureOutputDir` only, thus the lookup leaves it absent.
        expect(() => realpathSync(root.text)).toThrow();
    });

    test("an unlocatable workspace gives the message of the workspace error", async () => {
        const error = (await workspaceReadRoot("no-such-analysis"))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: "workspace_unavailable", message: expect.stringContaining("no longer exists") });
    });
});
