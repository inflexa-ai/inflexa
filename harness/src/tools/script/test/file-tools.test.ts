import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeSha256 } from "../../../lib/fs-helpers.js";
import type { SessionProvenanceEvent } from "../../../provenance/seam.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import { createWorkspaceFilesystem } from "../../../workspace/filesystem.js";
import { conversationSessionDir } from "../../../workspace/paths.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { readToolCallRecord, type Tool, type ToolContext } from "../../define-tool.js";
import { createScriptFileTools } from "../file-tools.js";
import { createScriptScratch, type ScriptScratch } from "../scratch.js";

const ANALYSIS = "analysis-001";
const THREAD = "thread-1";
const DERIVED = `${conversationSessionDir(THREAD)}/derived`;

let root: string;
let events: SessionProvenanceEvent[];
let scratch: ScriptScratch;
let tools: Map<string, Tool>;

function ctx(invocationId = "call-1"): ToolContext {
    return { ...makeToolContext().ctx, invocationId, session: makeSession({ scope: { kind: "analysis", analysisId: ANALYSIS, threadId: THREAD } }) };
}

function tool(id: string): Tool {
    const found = tools.get(id);
    if (found === undefined) throw new Error(`no tool ${id}`);
    return found;
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "script-files-"));
    mkdirSync(join(root, "runs/r1/s1/output"), { recursive: true });
    writeFileSync(join(root, "runs/r1/s1/output/de.csv"), "gene,padj,id\nTP53,0.001,007\nFLT3,0.2,12\n");
    events = [];
    const resolveWorkspaceRoot = (): Promise<string> => Promise.resolve(root);
    scratch = createScriptScratch({
        resolveWorkspaceRoot,
        sessionDir: conversationSessionDir,
        provenance: { emitSessionEvent: (event) => events.push(event) },
    });
    const list = createScriptFileTools({ workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot }), resolveWorkspaceRoot, scratch });
    tools = new Map(list.map((t) => [t.id, t]));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("read_table", () => {
    test("reads the rows, a plain number as a number, and an identifier with a leading zero as text", async () => {
        const result = (await tool("read_table").execute({ path: "runs/r1/s1/output/de.csv" }, ctx()))._unsafeUnwrap();

        expect(result).toMatchObject({
            path: "runs/r1/s1/output/de.csv",
            columns: ["gene", "padj", "id"],
            rowCount: 2,
            rows: [
                { gene: "TP53", padj: 0.001, id: "007" },
                { gene: "FLT3", padj: 0.2, id: 12 },
            ],
        });
        const bytes = readFileSync(join(root, "runs/r1/s1/output/de.csv"));
        expect(readToolCallRecord(result)).toEqual({ reads: [{ path: "runs/r1/s1/output/de.csv", hash: computeSha256(bytes) }] });
    });

    test("keeps only the named columns, and names the columns when one is missing", async () => {
        const kept = (await tool("read_table").execute({ path: "runs/r1/s1/output/de.csv", columns: ["gene"] }, ctx()))._unsafeUnwrap();
        expect(kept).toMatchObject({ columns: ["gene"], rows: [{ gene: "TP53" }, { gene: "FLT3" }] });

        const missing = await tool("read_table").execute({ path: "runs/r1/s1/output/de.csv", columns: ["log2fc"] }, ctx());
        expect(missing._unsafeUnwrapErr().error).toBe("runs/r1/s1/output/de.csv has no column log2fc; its columns are gene, padj, id");
    });

    test("refuses a format with no parser, a missing file, and a path of another analysis", async () => {
        writeFileSync(join(root, "runs/r1/s1/output/cells.h5ad"), "x");

        const format = await tool("read_table").execute({ path: "runs/r1/s1/output/cells.h5ad" }, ctx());
        const missing = await tool("read_table").execute({ path: "runs/r1/s1/output/none.csv" }, ctx());
        const foreign = await tool("read_table").execute({ path: "/analysis-002/runs/r1/s1/output/de.csv" }, ctx());

        expect(format._unsafeUnwrapErr().error).toContain("has no table format that a script reads");
        expect(missing._unsafeUnwrapErr().error).toContain("does not exist");
        expect(foreign._unsafeUnwrapErr().error).toContain("is outside this analysis");
    });

    test("refuses a table over the cap of a script read", async () => {
        writeFileSync(join(root, "runs/r1/s1/output/big.csv"), `a\n${"1\n".repeat(9 * 1024 * 1024)}`);

        const result = await tool("read_table").execute({ path: "runs/r1/s1/output/big.csv" }, ctx());

        expect(result._unsafeUnwrapErr().error).toContain("over the 16 MiB cap of a script read");
    });
});

describe("write_derived", () => {
    test("writes rows as CSV in the derived directory of the conversation, with each cell quoted where it must be", async () => {
        const result = (
            await tool("write_derived").execute(
                {
                    name: "top.csv",
                    rows: [
                        { gene: "TP53", note: "a, b" },
                        { gene: "FLT3", note: null },
                    ],
                },
                ctx(),
            )
        )._unsafeUnwrap();

        const text = readFileSync(join(root, DERIVED, "top.csv"), "utf8");
        expect(text).toBe('gene,note\nTP53,"a, b"\nFLT3,\n');
        expect(result).toMatchObject({ path: `${DERIVED}/top.csv`, bytes: text.length });
        expect(readToolCallRecord(result)).toEqual({ writes: [{ path: `${DERIVED}/top.csv`, hash: computeSha256(Buffer.from(text)), size: text.length }] });
    });

    test("the same bytes under a name pass again, and other bytes under the name are refused", async () => {
        (await tool("write_derived").execute({ name: "notes.md", content: "one" }, ctx()))._unsafeUnwrap();

        const again = await tool("write_derived").execute({ name: "notes.md", content: "one" }, ctx("call-2"));
        const other = await tool("write_derived").execute({ name: "notes.md", content: "two" }, ctx("call-3"));

        expect(again.isOk()).toBe(true);
        expect(other._unsafeUnwrapErr().error).toBe("this session already holds a different notes.md, thus this file takes a new name");
        expect(readFileSync(join(root, DERIVED, "notes.md"), "utf8")).toBe("one");
    });

    test("refuses a name with a directory, rows under a name that names no table format, and both content and rows", async () => {
        const nested = await tool("write_derived").execute({ name: "../x.csv", content: "a" }, ctx());
        const format = await tool("write_derived").execute({ name: "x.txt", rows: [{ a: 1 }] }, ctx());
        const both = await tool("write_derived").execute({ name: "x.csv", content: "a", rows: [{ a: 1 }] }, ctx());

        expect(nested._unsafeUnwrapErr().error).toContain("one file name");
        expect(format._unsafeUnwrapErr().error).toContain("names no table format");
        expect(both._unsafeUnwrapErr().error).toBe("give exactly one of `content` and `rows`");
    });

    test("refuses a symbolic link at the name", async () => {
        mkdirSync(join(root, DERIVED), { recursive: true });
        symlinkSync(join(root, "runs/r1/s1/output/de.csv"), join(root, DERIVED, "de.csv"));

        const result = await tool("write_derived").execute({ name: "de.csv", content: "x" }, ctx());

        expect(result._unsafeUnwrapErr().error).toBe(`${DERIVED}/de.csv is not a regular file`);
    });
});

describe("render_chart", () => {
    test("writes an SVG at the double column width", async () => {
        const spec = { xAxis: { type: "category" }, yAxis: { type: "value" }, dataset: { source: [{ g: "a", v: 1 }] }, series: [{ type: "bar" }] };

        const result = (await tool("render_chart").execute({ name: "bars", spec }, ctx()))._unsafeUnwrap();

        expect(result).toMatchObject({ path: `${DERIVED}/bars.svg` });
        const svg = readFileSync(join(root, DERIVED, "bars.svg"), "utf8");
        expect(svg.startsWith("<svg")).toBe(true);
        expect(svg).toContain('width="183mm"');
    });

    test("refuses a chart with more points than an SVG file holds", async () => {
        const source = Array.from({ length: 10_001 }, (_, i) => ({ x: i, y: i }));
        const spec = { xAxis: {}, yAxis: {}, dataset: { source }, series: [{ type: "scatter" }] };

        const result = await tool("render_chart").execute({ name: "cloud.svg", spec }, ctx());

        expect(result._unsafeUnwrapErr().error).toContain("the chart draws 10001 points");
    });
});

describe("the scratch directory", () => {
    test("saves a script under the id of its call, and a scope with no thread saves nothing", async () => {
        const saved = await scratch.saveScript({ session: ctx().session, invocationId: "toolu_01", code: "return 1;" });
        const none = await scratch.saveScript({ session: makeSession(), invocationId: "toolu_02", code: "return 2;" });

        expect(saved?.path).toBe(`${conversationSessionDir(THREAD)}/scripts/toolu_01.js`);
        expect(readFileSync(join(root, conversationSessionDir(THREAD), "scripts/toolu_01.js"), "utf8")).toBe("return 1;");
        expect(none).toBeUndefined();
    });

    test("records a script that read or wrote a file, and nothing for a script that only looked up", () => {
        const base = { analysisId: ANALYSIS, threadId: THREAD, invocationId: "c", tools: ["pubmed"], ok: true };
        scratch.recordRun({ ...base, reads: [], writes: [] });
        scratch.recordRun({ ...base, reads: [{ path: "runs/r1/s1/output/de.csv", hash: "h1" }], writes: [] });

        expect(events).toEqual([
            {
                type: "run-script",
                analysisId: ANALYSIS,
                threadId: THREAD,
                invocationId: "c",
                reads: [{ path: "runs/r1/s1/output/de.csv", hash: "h1" }],
                writes: [],
                tools: ["pubmed"],
                ok: true,
            },
        ]);
    });
});
