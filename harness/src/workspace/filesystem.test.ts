import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unwrapOrThrow } from "../lib/result.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import { createWorkspaceFilesystem, type PresignedFallback, type WorkspaceFilesystem } from "./filesystem.js";

const ANALYSIS = "analysis-001";

async function makeRoot() {
    const sessions = await mkdtemp(join(tmpdir(), "wsfs-"));
    await mkdir(join(sessions, ANALYSIS, "data", "inputs"), { recursive: true });
    return sessions;
}

describe("createWorkspaceFilesystem", () => {
    let sessions: string;
    let fs: WorkspaceFilesystem;
    const session = makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS } });

    beforeEach(async () => {
        sessions = await makeRoot();
        fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(sessions, id) });
    });

    afterEach(async () => {
        await rm(sessions, { recursive: true, force: true });
    });

    it("reads a materialized file as ok", async () => {
        await writeFile(join(sessions, ANALYSIS, "data", "inputs", "x.csv"), "sample_id,gene\n1,BRCA1\n");
        const r = (await fs.readFile({ session, path: "data/inputs/x.csv" }))._unsafeUnwrap();
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.content.toString("utf8")).toContain("BRCA1");
        }
    });

    // `ResolveWorkspaceRoot` throws for an unresolvable resource (the DBOS-body contract), but this
    // seam promises `Result` and its tools run inside live chat turns. The throw must not escape.
    describe("an unresolvable workspace root", () => {
        const unresolvable = createWorkspaceFilesystem({
            resolveWorkspaceRoot: () => {
                throw new Error("analysis folder is gone");
            },
        });

        it("surfaces on readFile as an err, not a throw", async () => {
            expect((await unresolvable.readFile({ session, path: "data/inputs/x.csv" }))._unsafeUnwrapErr().type).toBe("read_failed");
        });

        it("surfaces on list as an err, not a throw", async () => {
            expect((await unresolvable.list({ session, path: "data" }))._unsafeUnwrapErr().op).toBe("workspace.resolveWorkspaceRoot");
        });

        it("surfaces on stat as an err, not a throw", async () => {
            expect((await unresolvable.stat({ session, path: "data" }))._unsafeUnwrapErr().type).toBe("read_failed");
        });
    });

    it("returns not_found for a missing path with no presigned fallback", async () => {
        const r = (await fs.readFile({ session, path: "data/inputs/missing.csv" }))._unsafeUnwrap();
        expect(r.kind).toBe("not_found");
    });

    it("returns truncated when the local file exceeds maxBytes", async () => {
        const payload = Buffer.alloc(2048, 0x41); // 'A' x 2048
        await writeFile(join(sessions, ANALYSIS, "data", "inputs", "big.bin"), payload);
        const r = (
            await fs.readFile({
                session,
                path: "data/inputs/big.bin",
                maxBytes: 1024,
            })
        )._unsafeUnwrap();
        expect(r.kind).toBe("truncated");
        if (r.kind === "truncated") {
            expect(r.content.length).toBe(1024);
            expect(r.totalSize).toBe(2048);
        }
    });

    it("returns out_of_scope for a traversal that escapes the analysis tree", async () => {
        const r = (await fs.readFile({ session, path: "../other-analysis/x.csv" }))._unsafeUnwrap();
        expect(r.kind).toBe("out_of_scope");
    });

    it("returns out_of_scope for /etc/passwd-style absolute paths", async () => {
        const r = (await fs.readFile({ session, path: "/etc/passwd" }))._unsafeUnwrap();
        expect(r.kind).toBe("out_of_scope");
    });

    it("falls back to presigned fetch when local is missing", async () => {
        const fallback: PresignedFallback = {
            async fetch({ relativePath }) {
                expect(relativePath).toBe("data/inputs/cold.csv");
                return Buffer.from("from-nexus");
            },
        };
        const fs2 = createWorkspaceFilesystem({
            resolveWorkspaceRoot: (id) => join(sessions, id),
            presignedFallback: fallback,
        });
        const r = (await fs2.readFile({ session, path: "data/inputs/cold.csv" }))._unsafeUnwrap();
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.content.toString("utf8")).toBe("from-nexus");
        }
    });

    it("reports an unexpected presigned-fetch failure as err(fetch_failed)", async () => {
        const fallback: PresignedFallback = {
            async fetch() {
                throw new Error("upstream 502");
            },
        };
        const fs2 = createWorkspaceFilesystem({
            resolveWorkspaceRoot: (id) => join(sessions, id),
            presignedFallback: fallback,
        });
        const result = await fs2.readFile({ session, path: "data/inputs/cold.csv" });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("fetch_failed");
            expect((result.error.cause as Error).message).toContain("upstream 502");
        }
        // The tool edge would `unwrapOrThrow` this Result. `fetch_failed` carries no
        // `message` field, so the thrown `ResultError.message` falls back to the
        // `type` discriminant; the original "upstream 502" rides on `.cause`.
        expect(() => unwrapOrThrow(result)).toThrow("fetch_failed");
    });

    it("lists directory entries with type and size", async () => {
        const dir = join(sessions, ANALYSIS, "data", "inputs");
        await writeFile(join(dir, "a.csv"), "1");
        await writeFile(join(dir, "b.csv"), "22");
        await mkdir(join(dir, "sub"));

        const r = (await fs.list({ session, path: "data/inputs" }))._unsafeUnwrap();
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            const names = r.entries.map((e) => e.name).sort();
            expect(names).toEqual(["a.csv", "b.csv", "sub"]);
            const sub = r.entries.find((e) => e.name === "sub")!;
            expect(sub.type).toBe("directory");
            const a = r.entries.find((e) => e.name === "a.csv")!;
            expect(a.type).toBe("file");
            expect(a.size).toBe(1);
        }
    });

    it("list returns out_of_scope for a traversal path", async () => {
        const r = (await fs.list({ session, path: "../" }))._unsafeUnwrap();
        expect(r.kind).toBe("out_of_scope");
    });

    it("headLines returns only the first N lines of a multi-line file", async () => {
        const body = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");
        await writeFile(join(sessions, ANALYSIS, "data", "inputs", "big.csv"), body);
        const r = (
            await fs.readFile({
                session,
                path: "data/inputs/big.csv",
                headLines: 5,
            })
        )._unsafeUnwrap();
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            const lines = r.content.toString("utf8").split("\n");
            expect(lines).toEqual(["line1", "line2", "line3", "line4", "line5"]);
        }
    });

    it("tailLines returns only the last N complete lines", async () => {
        const body = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");
        await writeFile(join(sessions, ANALYSIS, "data", "inputs", "log.txt"), body);
        const r = (
            await fs.readFile({
                session,
                path: "data/inputs/log.txt",
                tailLines: 3,
            })
        )._unsafeUnwrap();
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            const lines = r.content.toString("utf8").split("\n");
            expect(lines).toEqual(["line98", "line99", "line100"]);
        }
    });

    it("headLines stops early — does not page the whole file into RAM", async () => {
        // Build a file where 5 lines is far less than the byte cap. Even with a
        // tiny maxBytes (smaller than the file), reading the head should succeed
        // because we stop streaming after we have 5 lines.
        const body = Array.from({ length: 10_000 }, (_, i) => `row${i}`).join("\n");
        await writeFile(join(sessions, ANALYSIS, "data", "inputs", "huge.csv"), body);
        const r = (
            await fs.readFile({
                session,
                path: "data/inputs/huge.csv",
                headLines: 5,
                maxBytes: 1024,
            })
        )._unsafeUnwrap();
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            const lines = r.content.toString("utf8").split("\n");
            expect(lines).toEqual(["row0", "row1", "row2", "row3", "row4"]);
        }
    });

    it("tailLines reads via a window from the end — bounded by maxBytes", async () => {
        const body = Array.from({ length: 10_000 }, (_, i) => `row${i}`).join("\n");
        await writeFile(join(sessions, ANALYSIS, "data", "inputs", "huge.csv"), body);
        const r = (
            await fs.readFile({
                session,
                path: "data/inputs/huge.csv",
                tailLines: 3,
                maxBytes: 64 * 1024,
            })
        )._unsafeUnwrap();
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            const lines = r.content.toString("utf8").split("\n");
            expect(lines).toEqual(["row9997", "row9998", "row9999"]);
        }
    });

    it("headLines on a small file returns the whole file when fewer lines exist", async () => {
        await writeFile(join(sessions, ANALYSIS, "data", "inputs", "short.csv"), "a\nb\nc");
        const r = (
            await fs.readFile({
                session,
                path: "data/inputs/short.csv",
                headLines: 100,
            })
        )._unsafeUnwrap();
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.content.toString("utf8")).toBe("a\nb\nc");
        }
    });

    it("stat returns ok / not_found / out_of_scope", async () => {
        await writeFile(join(sessions, ANALYSIS, "data", "inputs", "x.csv"), "x");
        const present = (await fs.stat({ session, path: "data/inputs/x.csv" }))._unsafeUnwrap();
        expect(present.kind).toBe("ok");
        if (present.kind === "ok") expect(present.type).toBe("file");

        const missing = (await fs.stat({ session, path: "nope.csv" }))._unsafeUnwrap();
        expect(missing.kind).toBe("not_found");

        const escape = (await fs.stat({ session, path: "/etc/passwd" }))._unsafeUnwrap();
        expect(escape.kind).toBe("out_of_scope");
    });
});
