import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isSha256Hash } from "../../../lib/test/text-shapes.js";
import { parseJsonAs } from "../../../lib/parse-json.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile as readHostFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import { z } from "zod";

import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { readToolCallRecord } from "../../define-tool.js";
import { computeSha256 } from "../../../lib/fs-helpers.js";
import { isUnknownArray } from "../../../lib/unknown-array.js";
import { parseUnknownRecord } from "../../../lib/unknown-containers.js";
import { createEditFileTool, type EditIntent, type EditIntentStore } from "../edit-file.js";
import { createReadFileTool } from "../read-file.js";
import { createWorkspaceMutator } from "../mutator.js";
import { createWorkspaceFilesystem } from "../../../workspace/filesystem.js";
import { stepWritePrefix } from "../../../workspace/paths.js";

const ANALYSIS = "analysis-001";
const RUN = "run-abc";
const STEP = "step-1";

/** The JSON of a written decision record, narrowed to the object the tool wrote. */
function asRecord(json: unknown): Record<string, unknown> {
    const record = parseUnknownRecord(json);
    if (record === undefined) throw new Error("the decision record stored no object");
    return record;
}

/** An in-memory intent store. `failPut` keeps the intent and then fails the put, as a process that dies after the insert. */
function createFakeIntentStore(opts: { readonly failPut?: boolean; readonly intents?: Map<string, EditIntent> } = {}) {
    const intents = opts.intents ?? new Map<string, EditIntent>();
    const store: EditIntentStore = {
        put: (intent) => {
            intents.set(intent.key, structuredClone(intent));
            return opts.failPut === true ? errAsync({ type: "mutation_failed", op: "fake.put", cause: undefined }) : okAsync(undefined);
        },
        get: (key) => okAsync(intents.get(key) ?? null),
    };
    return { store, intents };
}

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

    function buildTool(opts: { readonly intents?: EditIntentStore; readonly stepKey?: () => string | undefined } = {}) {
        const workspaceRoot = join(sessionsBasePath, ANALYSIS);
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => Promise.resolve(join(sessionsBasePath, id)) });
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
            intents: opts.intents ?? createFakeIntentStore().store,
            stepKey: opts.stepKey,
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
                    regex: false,
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

    it("notes an edit of a rendered script on its decision record, with the digest after the change", async () => {
        const stepDir = join(sessionsBasePath, ANALYSIS, "runs", RUN, STEP);
        await mkdir(join(stepDir, "scripts"), { recursive: true });
        await writeFile(join(stepDir, "scripts", "de.R"), "ALPHA <- 0.05  # [adaptable: alpha]\n");
        await writeFile(
            join(stepDir, "output", "decision_record_de.json"),
            JSON.stringify({ template: { id: "tpl-x" }, written_sha256: "sha256:old", unvetted_edits: [] }),
        );
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute({ path: "scripts/de.R", old_string: "0.05", new_string: "0.1", replace_all: false, regex: false }, ctx)
        )._unsafeUnwrap();
        expect(out).toMatchObject({ status: "ok", decision_record_noted: true });

        const record = asRecord(parseJsonAs(await readHostFile(join(stepDir, "output", "decision_record_de.json"), "utf8"), z.json()));
        expect(record.written_sha256).toBe("sha256:old");
        const edits = record.unvetted_edits;
        if (!isUnknownArray(edits) || edits.length !== 1) throw new Error("the record stored no unvetted edit");
        const editRecord = parseUnknownRecord(edits[0]);
        if (editRecord === undefined || !("sha256" in editRecord)) throw new Error("the edit carries no sha256");
        const { sha256, ...editShape } = editRecord;
        expect(editShape).toEqual({ path: "scripts/de.R", note: "edit_file: 1 replacement(s)" });
        expect(typeof sha256 === "string" && isSha256Hash(sha256)).toBe(true);
        const edited = await readHostFile(join(stepDir, "scripts", "de.R"), "utf8");
        expect(edited).toBe("ALPHA <- 0.1  # [adaptable: alpha]\n");

        // A file that is not a rendered script, and a script without a record, note nothing.
        await seed("hello world");
        const plain = (
            await tool.execute(
                { path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`, old_string: "world", new_string: "there", replace_all: false, regex: false },
                ctx,
            )
        )._unsafeUnwrap();
        expect(plain).toMatchObject({ status: "ok" });
        expect("decision_record_noted" in plain).toBe(false);
        await writeFile(join(stepDir, "scripts", "own.R"), "x <- 1\n");
        const own = (await tool.execute({ path: "scripts/own.R", old_string: "1", new_string: "2", replace_all: false, regex: false }, ctx))._unsafeUnwrap();
        expect(own).toMatchObject({ status: "ok" });
        expect("decision_record_noted" in own).toBe(false);
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
                    regex: false,
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
                    regex: false,
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
                    regex: false,
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
                    regex: false,
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
                    regex: false,
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
                    replace_all: false,
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
                    replace_all: false,
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
            await tool.execute(
                { path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`, old_string: "a", new_string: "b", regex: true, replace_all: false },
                ctx,
            )
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
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "a",
                    new_string: "b",
                    regex: false,
                    replace_all: false,
                    expected_matches: 1,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("invalid_arguments");
        expect(await readHostFile(hostPath(), "utf8")).toBe("abc\n");
    });

    describe("inside a durable step", () => {
        const KEY = "wf-1:7";
        const EDIT = { path: "output/notes.md", old_string: "world", new_string: "harness", replace_all: false, regex: false };

        function outputEntries(): string[] {
            return readdirSync(join(sessionsBasePath, ANALYSIS, "runs", RUN, STEP, "output")).sort();
        }

        it("records the hashes and the result while the file still holds the old text", async () => {
            await seed("hello world");
            const fake = createFakeIntentStore();
            const seenAtPut: string[] = [];
            const store: EditIntentStore = {
                put: (intent) => {
                    seenAtPut.push(readFileSync(hostPath(), "utf8"));
                    return fake.store.put(intent);
                },
                get: (key) => fake.store.get(key),
            };
            const { tool } = buildTool({ intents: store, stepKey: () => KEY });
            const { ctx } = makeToolContext();

            const out = (await tool.execute(EDIT, ctx))._unsafeUnwrap();

            expect(out.status).toBe("ok");
            expect(seenAtPut).toEqual(["hello world"]);
            const stored = fake.intents.get(KEY);
            expect(stored).toMatchObject({
                key: KEY,
                analysisId: ctx.session.scope.analysisId,
                path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                hashBefore: computeSha256(Buffer.from("hello world", "utf8")),
                hashAfter: computeSha256(Buffer.from("hello harness", "utf8")),
            });
            expect(stored?.result).toEqual({ status: "ok", path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`, replacements: 1, bytesWritten: 13 });
            expect(readToolCallRecord(out)).toEqual(stored?.callRecord);
            expect(outputEntries()).toEqual(["notes.md"]);
        });

        it("gives back the stored result at the hash after, and writes nothing", async () => {
            await seed("hello world");
            const { store, intents } = createFakeIntentStore();
            const { tool } = buildTool({ intents: store, stepKey: () => KEY });
            const { ctx } = makeToolContext();
            const first = (await tool.execute(EDIT, ctx))._unsafeUnwrap();
            const inode = statSync(hostPath()).ino;

            const rerun = (await tool.execute(EDIT, ctx))._unsafeUnwrap();

            expect(rerun).toEqual(first);
            expect(readToolCallRecord(rerun)).toEqual(readToolCallRecord(first));
            expect(statSync(hostPath()).ino).toBe(inode);
            expect(await readHostFile(hostPath(), "utf8")).toBe("hello harness");
            expect([...intents.keys()]).toEqual([KEY]);
        });

        it("gives back the note of the decision record and both write records at the hash after, and notes nothing again", async () => {
            const stepDir = join(sessionsBasePath, ANALYSIS, "runs", RUN, STEP);
            await mkdir(join(stepDir, "scripts"), { recursive: true });
            await writeFile(join(stepDir, "scripts", "de.R"), "ALPHA <- 0.05\n");
            await writeFile(join(stepDir, "output", "decision_record_de.json"), JSON.stringify({ written_sha256: "sha256:old", unvetted_edits: [] }));
            const { store } = createFakeIntentStore();
            const { tool } = buildTool({ intents: store, stepKey: () => KEY });
            const { ctx } = makeToolContext();
            const edit = { path: "scripts/de.R", old_string: "0.05", new_string: "0.1", replace_all: false, regex: false };
            const first = (await tool.execute(edit, ctx))._unsafeUnwrap();
            const record = await readHostFile(join(stepDir, "output", "decision_record_de.json"), "utf8");

            const rerun = (await tool.execute(edit, ctx))._unsafeUnwrap();

            expect(rerun).toEqual(first);
            expect(rerun).toMatchObject({ status: "ok", decision_record_noted: true });
            const records = readToolCallRecord(rerun);
            expect(records).toEqual(readToolCallRecord(first));
            expect(isUnknownArray(records) ? records.length : 0).toBe(2);
            expect(await readHostFile(join(stepDir, "output", "decision_record_de.json"), "utf8")).toBe(record);
        });

        it("applies the edit again at the hash before, after a run that died before the write landed", async () => {
            await seed("hello world");
            const { ctx } = makeToolContext();
            const crashed = createFakeIntentStore({ failPut: true });

            await expect(buildTool({ intents: crashed.store, stepKey: () => KEY }).tool.execute(EDIT, ctx)).rejects.toThrow("mutation_failed");
            expect(await readHostFile(hostPath(), "utf8")).toBe("hello world");
            expect(outputEntries()).toEqual(["notes.md"]);
            expect(crashed.intents.get(KEY)?.hashBefore).toBe(computeSha256(Buffer.from("hello world", "utf8")));

            const rerunStore = createFakeIntentStore({ intents: crashed.intents });
            const rerun = (await buildTool({ intents: rerunStore.store, stepKey: () => KEY }).tool.execute(EDIT, ctx))._unsafeUnwrap();

            expect(rerun).toMatchObject({ status: "ok", replacements: 1 });
            expect(await readHostFile(hostPath(), "utf8")).toBe("hello harness");
            expect(crashed.intents.get(KEY)?.result).toEqual({
                status: "ok",
                path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                replacements: 1,
                bytesWritten: 13,
            });
        });

        it("gives a conflict at another hash, and writes nothing", async () => {
            await seed("hello world");
            const { store } = createFakeIntentStore();
            const { tool } = buildTool({ intents: store, stepKey: () => KEY });
            const { ctx } = makeToolContext();
            (await tool.execute(EDIT, ctx))._unsafeUnwrap();
            await seed("hello there, world");

            const rerun = await tool.execute(EDIT, ctx);

            const conflict = rerun._unsafeUnwrapErr();
            expect(conflict.retryable).toBe(false);
            expect(conflict.error).toContain("changed after an earlier run of this edit");
            expect(await readHostFile(hostPath(), "utf8")).toBe("hello there, world");
        });

        it("writes no intent outside a workflow, where nothing reruns", async () => {
            await seed("hello world");
            const { store, intents } = createFakeIntentStore();
            const { tool } = buildTool({ intents: store });
            const { ctx } = makeToolContext();

            const out = (await tool.execute(EDIT, ctx))._unsafeUnwrap();

            expect(out.status).toBe("ok");
            expect(await readHostFile(hostPath(), "utf8")).toBe("hello harness");
            expect(intents.size).toBe(0);
        });
    });
});
