import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { GREP_LIMITS, createGrepTool } from "./grep.js";

interface FakeTree {
    /** path → file content (utf8). Path is workspace-relative. */
    readonly files: Record<string, string>;
    /** path → directory entries. */
    readonly dirs: Record<string, readonly { name: string; type: "file" | "directory" }[]>;
}

function fakeFs(tree: FakeTree): WorkspaceFilesystem {
    return {
        stat({ path }) {
            if (path in tree.files) return okAsync({ kind: "ok", type: "file", size: tree.files[path]!.length });
            if (path in tree.dirs) return okAsync({ kind: "ok", type: "directory", size: 0 });
            return okAsync({ kind: "not_found" });
        },
        list({ path }) {
            const entries = tree.dirs[path];
            if (!entries) return okAsync({ kind: "not_found" });
            return okAsync({ kind: "ok", entries });
        },
        readFile({ path }) {
            const content = tree.files[path];
            if (content === undefined) return okAsync({ kind: "not_found" });
            return okAsync({ kind: "ok", content: Buffer.from(content), truncated: false });
        },
    };
}

describe("createGrepTool", () => {
    it("returns matches for a single file", async () => {
        const tool = createGrepTool(
            fakeFs({
                files: { "a.csv": "sample_id,gene\n1,BRCA1\n2,TP53\n" },
                dirs: {},
            }),
        );
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ pattern: "BRCA1", path: "a.csv" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("ok");
        if (r.status === "ok") {
            expect(r.matches).toHaveLength(1);
            expect(r.matches[0]!.line).toBe(2);
            expect(r.matches[0]!.preview).toContain("BRCA1");
        }
    });

    it("returns no_matches when nothing matches", async () => {
        const tool = createGrepTool(fakeFs({ files: { "a.csv": "irrelevant" }, dirs: {} }));
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ pattern: "BRCA1", path: "a.csv" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("no_matches");
    });

    it("walks directories recursively", async () => {
        const tool = createGrepTool(
            fakeFs({
                files: {
                    "runs/r1/output/x.csv": "BRCA1 line\n",
                    "runs/r1/output/y.csv": "no hit\n",
                },
                dirs: {
                    "runs/r1/output": [
                        { name: "x.csv", type: "file" },
                        { name: "y.csv", type: "file" },
                    ],
                },
            }),
        );
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ pattern: "BRCA1", path: "runs/r1/output" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("ok");
        if (r.status === "ok") {
            expect(r.matches.map((m) => m.file)).toEqual(["runs/r1/output/x.csv"]);
        }
    });

    it("returns truncated when match count exceeds the cap", async () => {
        const lines = Array.from({ length: GREP_LIMITS.DEFAULT_MAX_MATCHES + 5 }, () => "BRCA1").join("\n");
        const tool = createGrepTool(fakeFs({ files: { "a.csv": lines }, dirs: {} }));
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ pattern: "BRCA1", path: "a.csv" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("truncated");
        if (r.status === "truncated") {
            expect(r.matches.length).toBe(GREP_LIMITS.DEFAULT_MAX_MATCHES);
        }
    });

    it("returns out_of_scope when the seam rejects the path", async () => {
        const fs: WorkspaceFilesystem = {
            stat() {
                return okAsync({ kind: "out_of_scope" });
            },
            list() {
                return okAsync({ kind: "out_of_scope" });
            },
            readFile() {
                return okAsync({ kind: "out_of_scope" });
            },
        };
        const tool = createGrepTool(fs);
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ pattern: "x", path: "/etc/passwd" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("out_of_scope");
    });

    it("returns invalid_pattern for a malformed regex", async () => {
        const tool = createGrepTool(fakeFs({ files: { "a.csv": "x" }, dirs: {} }));
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ pattern: "[unclosed", path: "a.csv" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("invalid_pattern");
    });

    it("ignoreCase finds matches in either case", async () => {
        const tool = createGrepTool(fakeFs({ files: { "a.csv": "brca1 line\n" }, dirs: {} }));
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ pattern: "BRCA1", path: "a.csv", ignoreCase: true }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("ok");
    });

    it("emits a valid Anthropic input schema", () => {
        const tool = createGrepTool(fakeFs({ files: {}, dirs: {} }));
        expect((tool.jsonSchema as { type?: unknown }).type).toBe("object");
    });
});
