import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVersionFsTools } from "./version-fs.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { Tool } from "../define-tool.js";

/** The offending path the builder actually typed in the reported incident. */
const ABSOLUTE_PATH = "/previews/abc/v1/report.html.j2";

type FsOutput = { status: string; reason?: string; bytesWritten?: number };

describe("versionFs path containment", () => {
    test("write_file refuses an absolute path and creates nothing under the version dir", async () => {
        const versionDir = await makeVersionDir();
        const out = await run(versionDir, "write_file", { path: ABSOLUTE_PATH, content: "<html>nope</html>" });

        expect(out.status).toBe("out_of_scope");
        expect(out.reason).toContain(ABSOLUTE_PATH);

        // The trap this guards: a stripped leading slash lands the file at a
        // nested location the agent never named, and reports ok.
        expect(await exists(join(versionDir, "previews", "abc", "v1", "report.html.j2"))).toBe(false);
        expect(await exists(join(versionDir, "report.html.j2"))).toBe(false);
    });

    test("write_file accepts a relative path and writes inside the version dir", async () => {
        const versionDir = await makeVersionDir();
        const out = await run(versionDir, "write_file", { path: "report.html.j2", content: "<html>ok</html>" });

        expect(out.status).toBe("ok");
        expect(await readFile(join(versionDir, "report.html.j2"), "utf8")).toBe("<html>ok</html>");
    });

    test("read_file refuses traversal outside the version dir", async () => {
        const versionDir = await makeVersionDir();
        const out = await run(versionDir, "read_file", { path: "../../etc/passwd" });

        expect(out.status).toBe("out_of_scope");
        expect(out.reason).toContain("../../etc/passwd");
    });

    test("every version-fs tool refuses an absolute path", async () => {
        const versionDir = await makeVersionDir();
        await run(versionDir, "write_file", { path: "report.html.j2", content: "seed" });

        const calls: ReadonlyArray<[string, Record<string, unknown>]> = [
            ["write_file", { path: ABSOLUTE_PATH, content: "x" }],
            ["edit_file", { path: ABSOLUTE_PATH, oldText: "seed", newText: "x" }],
            ["read_file", { path: ABSOLUTE_PATH }],
            ["mkdir", { path: "/previews/abc/v1/assets" }],
        ];

        for (const [id, input] of calls) {
            const out = await run(versionDir, id, input);
            expect(`${id}:${out.status}`).toBe(`${id}:out_of_scope`);
            expect(out.reason).toContain("/previews/abc/v1");
        }

        // The refusals left the tree exactly as the seed write did.
        expect(await exists(join(versionDir, "previews"))).toBe(false);
        expect(await readFile(join(versionDir, "report.html.j2"), "utf8")).toBe("seed");
    });
});

// ── helpers ─────────────────────────────────────────────────────────

async function makeVersionDir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "version-fs-test-"));
}

function toolById(versionDir: string, id: string): Tool {
    const tool = createVersionFsTools({ versionDir }).find((t) => t.id === id);
    if (!tool) {
        throw new Error(`no version-fs tool with id ${id}`);
    }
    return tool;
}

async function run(versionDir: string, id: string, input: Record<string, unknown>): Promise<FsOutput> {
    const { ctx } = makeToolContext();
    const result = await toolById(versionDir, id).execute(input, ctx);
    return result._unsafeUnwrap() as FsOutput;
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
