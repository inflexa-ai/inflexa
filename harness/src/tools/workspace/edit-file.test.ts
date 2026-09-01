import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile as readHostFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createEditFileTool } from "./edit-file.js";
import { createReadFileTool } from "./read-file.js";
import { createWorkspaceMutator } from "./mutator.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { stepWritePrefix } from "../../workspace/paths.js";

const ANALYSIS = "analysis-001";
const RUN = "run-abc";
const STEP = "step-1";

describe("edit_file tool", () => {
    let sessionsBasePath: string;

    beforeEach(async () => {
        sessionsBasePath = mkdtempSync(join(tmpdir(), "ef-test-"));
        const outputDir = join(sessionsBasePath, ANALYSIS, "runs", RUN, STEP, "output");
        await mkdir(outputDir, { recursive: true });
    });
    afterEach(() => {
        rmSync(sessionsBasePath, { recursive: true, force: true });
    });

    function buildTool() {
        const workspaceRoot = join(sessionsBasePath, ANALYSIS);
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(sessionsBasePath, id) });
        const workingDir = stepWritePrefix({
            workspaceRoot,
            runId: RUN,
            stepId: STEP,
        });
        const mutator = createWorkspaceMutator({
            workspaceRoot,
            analysisId: ANALYSIS,
            workingDir,
        });
        const tool = createEditFileTool({
            mutator,
            workspaceFilesystem: fs,
            workingDir,
        });
        return { tool, fs };
    }

    async function seed(content: string, file = "notes.md") {
        await writeFile(join(sessionsBasePath, ANALYSIS, "runs", RUN, STEP, "output", file), content);
    }

    function hostPath(file = "notes.md") {
        return join(sessionsBasePath, ANALYSIS, "runs", RUN, STEP, "output", file);
    }

    it("round-trip: edits a file in place and read surface returns the post-edit content", async () => {
        await seed("hello world");
        const { tool, fs } = buildTool();
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "world",
                    new_string: "harness",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("ok");

        const readTool = createReadFileTool(fs);
        const read = (await readTool.execute({ path: `runs/${RUN}/${STEP}/output/notes.md` }, ctx))._unsafeUnwrap();
        expect(read.status).toBe("ok");
        if (read.status === "ok") expect(read.content).toBe("hello harness");
    });

    it("rejects edits under the read-only inputs tree as out_of_prefix and lands nothing", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        await mkdir(join(sessionsBasePath, ANALYSIS, "data", "inputs"), {
            recursive: true,
        });
        await writeFile(join(sessionsBasePath, ANALYSIS, "data", "inputs", "x.csv"), "a");
        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/data/inputs/x.csv`,
                    old_string: "a",
                    new_string: "b",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("out_of_prefix");
        expect(await readHostFile(join(sessionsBasePath, ANALYSIS, "data", "inputs", "x.csv"), "utf8")).toBe("a");
    });

    it("search/replace: unique match required when replace_all=false (canonical case)", async () => {
        await seed("import pandas as pd\nimport numpy as np\nimport pandas as pd\n");
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "import pandas as pd",
                    new_string: "import polars as pl",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("not_unique");
        expect(await readHostFile(hostPath(), "utf8")).toBe("import pandas as pd\nimport numpy as np\nimport pandas as pd\n");

        const out2 = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "import pandas as pd",
                    new_string: "import polars as pl",
                    replace_all: true,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out2.status).toBe("ok");
        if (out2.status === "ok") expect(out2.replacements).toBe(2);
    });

    it("returns not_found when old_string is absent", async () => {
        await seed("foo");
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "bar",
                    new_string: "baz",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("not_found");
    });

    it("returns file_not_found when the target file does not exist", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/missing.md`,
                    old_string: "a",
                    new_string: "b",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("file_not_found");
    });

    // ── regex mode ──────────────────────────────────────────────────

    it("regex + expected_matches: applies the edit when the count matches, reporting count and lines", async () => {
        await seed("gene_a\t1\ngene_b\t2\nother\t3\ngene_c\t4\n");
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "^gene_",
                    new_string: "GENE_",
                    regex: true,
                    expected_matches: 3,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("ok");
        if (out.status === "ok") {
            expect(out.replacements).toBe(3);
            expect(out.lines).toEqual([1, 2, 4]);
        }
        expect(await readHostFile(hostPath(), "utf8")).toBe("GENE_a\t1\nGENE_b\t2\nother\t3\nGENE_c\t4\n");
    });

    it("regex + expected_matches mismatch: writes nothing and reports the actual count and lines", async () => {
        const original = "gene_a\t1\ngene_b\t2\nother\t3\ngene_c\t4\n";
        await seed(original);
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "^gene_",
                    new_string: "GENE_",
                    regex: true,
                    expected_matches: 2,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("match_count_mismatch");
        if (out.status === "match_count_mismatch") {
            expect(out.expected).toBe(2);
            expect(out.actual).toBe(3);
            expect(out.lines).toEqual([1, 2, 4]);
        }
        expect(await readHostFile(hostPath(), "utf8")).toBe(original);
    });

    it("regex + replace_all replaces every match", async () => {
        await seed("x=1;\ny=2;\nz=3;\n");
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: ";$",
                    new_string: "",
                    regex: true,
                    replace_all: true,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("ok");
        if (out.status === "ok") {
            expect(out.replacements).toBe(3);
            expect(out.lines).toEqual([1, 2, 3]);
        }
        expect(await readHostFile(hostPath(), "utf8")).toBe("x=1\ny=2\nz=3\n");
    });

    it("regex replacement expands capture-group references", async () => {
        await seed('sample_1,"ctrl"\nsample_2,"case"\n');
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: 'sample_(\\d+),"(\\w+)"',
                    new_string: "s$1\t$2",
                    regex: true,
                    replace_all: true,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("ok");
        expect(await readHostFile(hostPath(), "utf8")).toBe("s1\tctrl\ns2\tcase\n");
    });

    it("regex with no match returns not_found and writes nothing", async () => {
        await seed("abc\n");
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute(
                { path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`, old_string: "^zzz$", new_string: "x", regex: true, replace_all: true },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("not_found");
        expect(await readHostFile(hostPath(), "utf8")).toBe("abc\n");
    });

    it("regex with an uncompilable pattern returns invalid_pattern", async () => {
        await seed("abc\n");
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute(
                { path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`, old_string: "([", new_string: "x", regex: true, replace_all: true },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("invalid_pattern");
    });

    it("regex mode requires exactly one of replace_all=true or expected_matches", async () => {
        await seed("abc\n");
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const neither = (
            await tool.execute({ path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`, old_string: "a", new_string: "b", regex: true }, ctx)
        )._unsafeUnwrap();
        expect(neither.status).toBe("invalid_arguments");

        const both = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "a",
                    new_string: "b",
                    regex: true,
                    replace_all: true,
                    expected_matches: 1,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(both.status).toBe("invalid_arguments");
        expect(await readHostFile(hostPath(), "utf8")).toBe("abc\n");
    });

    it("expected_matches without regex is refused, keeping the exact path unchanged", async () => {
        await seed("abc\n");
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute({ path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`, old_string: "a", new_string: "b", expected_matches: 1 }, ctx)
        )._unsafeUnwrap();
        expect(out.status).toBe("invalid_arguments");
        expect(await readHostFile(hostPath(), "utf8")).toBe("abc\n");
    });
});
