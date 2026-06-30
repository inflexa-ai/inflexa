import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ReadFileResult, WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { createReadFileTool } from "./read-file.js";

function fakeFs(behavior: (path: string) => ReadFileResult): WorkspaceFilesystem {
    return {
        readFile({ path }) {
            return okAsync(behavior(path));
        },
        list() {
            throw new Error("list: not used");
        },
        stat() {
            throw new Error("stat: not used");
        },
    };
}

describe("createReadFileTool", () => {
    it("returns ok with content for a present file", async () => {
        const tool = createReadFileTool(
            fakeFs(() => ({
                kind: "ok",
                content: Buffer.from("hello"),
                truncated: false,
            })),
        );
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ path: "data/inputs/x.csv" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("ok");
        if (r.status === "ok") expect(r.content).toBe("hello");
    });

    it("returns not_found as a data variant — no throw", async () => {
        const tool = createReadFileTool(fakeFs(() => ({ kind: "not_found" })));
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ path: "data/inputs/missing.csv" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("not_found");
    });

    it("returns out_of_scope as a data variant", async () => {
        const tool = createReadFileTool(fakeFs(() => ({ kind: "out_of_scope" })));
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ path: "/etc/passwd" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("out_of_scope");
    });

    it("returns truncated with totalSize for an oversize file", async () => {
        const tool = createReadFileTool(
            fakeFs(() => ({
                kind: "truncated",
                content: Buffer.alloc(1024, 0x41),
                totalSize: 1_000_000,
            })),
        );
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ path: "data/inputs/big.bin" }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("truncated");
        if (r.status === "truncated") {
            expect(r.returnedBytes).toBe(1024);
            expect(r.totalSize).toBe(1_000_000);
        }
    });

    it("throws when the seam throws (loop wraps as is_error)", async () => {
        const tool = createReadFileTool({
            readFile() {
                throw new Error("upstream 502");
            },
            list() {
                throw new Error("not used");
            },
            stat() {
                throw new Error("not used");
            },
        });
        const { ctx } = makeToolContext();
        let threw = false;
        try {
            await tool.execute({ path: "data/inputs/cold.csv" }, ctx);
        } catch (e) {
            threw = true;
            expect((e as Error).message).toContain("upstream 502");
        }
        expect(threw).toBe(true);
    });

    it("emits a valid Anthropic input schema", () => {
        const tool = createReadFileTool(fakeFs(() => ({ kind: "not_found" })));
        expect((tool.jsonSchema as { type?: unknown }).type).toBe("object");
    });

    it("forwards headLines to the seam and tags the response mode", async () => {
        let seenHead: number | undefined;
        let seenTail: number | undefined;
        const tool = createReadFileTool({
            readFile({ headLines, tailLines }) {
                seenHead = headLines;
                seenTail = tailLines;
                return okAsync({ kind: "ok", content: Buffer.from("a\nb\nc"), truncated: false });
            },
            list() {
                throw new Error("not used");
            },
            stat() {
                throw new Error("not used");
            },
        });
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ path: "x.csv", headLines: 3 }, ctx))._unsafeUnwrap();
        expect(seenHead).toBe(3);
        expect(seenTail).toBeUndefined();
        expect(r.status).toBe("ok");
        if (r.status === "ok") expect(r.mode).toBe("head");
    });

    it("forwards tailLines to the seam and tags the response mode", async () => {
        let seenTail: number | undefined;
        const tool = createReadFileTool({
            readFile({ tailLines }) {
                seenTail = tailLines;
                return okAsync({ kind: "ok", content: Buffer.from("y\nz"), truncated: false });
            },
            list() {
                throw new Error("not used");
            },
            stat() {
                throw new Error("not used");
            },
        });
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ path: "log.txt", tailLines: 2 }, ctx))._unsafeUnwrap();
        expect(seenTail).toBe(2);
        if (r.status === "ok") expect(r.mode).toBe("tail");
    });

    it("rejects headLines + tailLines together as invalid_input — no I/O", async () => {
        let called = false;
        const tool = createReadFileTool({
            readFile() {
                called = true;
                return okAsync({ kind: "not_found" });
            },
            list() {
                throw new Error("not used");
            },
            stat() {
                throw new Error("not used");
            },
        });
        const { ctx } = makeToolContext();
        const r = (await tool.execute({ path: "x.csv", headLines: 5, tailLines: 5 }, ctx))._unsafeUnwrap();
        expect(r.status).toBe("invalid_input");
        expect(called).toBe(false);
    });
});
