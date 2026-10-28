import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok } from "neverthrow";
import { z } from "zod";

import { runLoop, withRunScript } from "../../../loop/run-loop.js";
import type { AgentDefinition } from "../../../loop/types.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../../testing.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { defineTool, withToolResultImage, type Tool } from "../../define-tool.js";
import { createRunScriptTool, RUN_SCRIPT_TOOL_ID, type RunScriptOutput } from "../run-script.js";
import { readToolCallRecord, withToolCallRecord, type ToolContext } from "../../define-tool.js";
import type { SessionProvenanceEvent } from "../../../provenance/seam.js";
import { createWorkspaceFilesystem } from "../../../workspace/filesystem.js";
import { conversationSessionDir } from "../../../workspace/paths.js";
import { createScriptFileTools } from "../file-tools.js";
import { createScriptScratch } from "../scratch.js";

const searchGene = defineTool({
    id: "search_gene",
    description: "Resolve gene identifiers against Ensembl. Batch up to 200 identifiers.",
    inputSchema: z.object({ identifiers: z.array(z.string()).min(1) }),
    describeCall: "none",
    execute: ({ identifiers }) => Promise.resolve(ok({ genes: identifiers.map((symbol, i) => ({ symbol, id: `ENSG${i}` })), notFound: [] })),
});

const pubmed = defineTool({
    id: "pubmed",
    description: "Search PubMed. Returns PMIDs and titles.",
    inputSchema: z.object({ query: z.string() }),
    describeCall: "none",
    execute: ({ query }) =>
        query === "fail"
            ? Promise.resolve(err({ error: "PubMed is unavailable", retryable: true }))
            : Promise.resolve(ok({ totalFound: 3, results: [1, 2, 3].map((n) => ({ pmid: String(n), title: `${query} ${n}` })) })),
});

async function run(code: string, tools: readonly Tool[] = [searchGene, pubmed]): Promise<RunScriptOutput> {
    return (await createRunScriptTool(tools).execute({ code }, makeToolContext().ctx))._unsafeUnwrap();
}

describe("run_script", () => {
    test("runs tools in parallel, and only what the script prints and returns comes back", async () => {
        const result = await run(`
            const [genes, papers] = await Promise.all([
                tools.search_gene({ identifiers: ["TP53", "FLT3"] }),
                tools.pubmed({ query: "TP53 AML" }),
            ]);
            text("genes: " + genes.genes.map((g) => g.symbol).join(","));
            return papers.results.filter((p) => p.pmid !== "2").map((p) => p.pmid);
        `);

        expect(result).toEqual({
            ok: true,
            output: "genes: TP53,FLT3",
            value: ["1", "3"],
            calls: [
                { tool: "search_gene", ok: true },
                { tool: "pubmed", ok: true },
            ],
        });
    });

    test("folds the call record of each nested call into its tool, in the order of the calls", async () => {
        const folded: unknown[] = [];
        const lookup = defineTool({
            id: "lookup",
            description: "Look up an id.",
            inputSchema: z.object({ id: z.string() }),
            describeCall: "none",
            foldCallRecord: (record) => {
                folded.push(record);
            },
            execute: ({ id }) => Promise.resolve(ok(withToolCallRecord({ id }, { seen: id }))),
        });
        const tool = createRunScriptTool([lookup]);

        const result = (
            await tool.execute({ code: 'await tools.lookup({ id: "a" }); await tools.lookup({ id: "b" });' }, makeToolContext().ctx)
        )._unsafeUnwrap();
        tool.foldCallRecord?.(readToolCallRecord(result));

        expect(folded).toEqual([{ seen: "a" }, { seen: "b" }]);
    });

    test("runs each nested call in the async context of the run_script call, as a durable step reads it", async () => {
        const store = new AsyncLocalStorage<string>();
        const reader = defineTool({
            id: "read_context",
            description: "Read the context of the call.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () => Promise.resolve(ok({ context: store.getStore() ?? "lost" })),
        });

        const result = await store.run("the step of the call", () => run("return (await tools.read_context({})).context;", [reader]));

        expect(result).toMatchObject({ ok: true, value: "the step of the call" });
    });

    test("shows the result type of a tool in its signature", () => {
        const typed = defineTool({
            id: "count_genes",
            description: "Count the genes of a set.",
            inputSchema: z.object({ set: z.string() }),
            outputSchema: z.object({ count: z.number().describe("The number of genes.") }),
            describeCall: "none",
            execute: () => Promise.resolve(ok({ count: 3 })),
        });

        expect(createRunScriptTool([typed]).description).toContain("count_genes(args: { set: string; }): Promise<{ count: number; }>;");
    });

    test("a failed tool call is an Error that the script can catch", async () => {
        const result = await run(`
            try { await tools.pubmed({ query: "fail" }); } catch (e) { text("caught: " + e.message); }
        `);

        expect(result).toMatchObject({ ok: true, output: "caught: pubmed: PubMed is unavailable", calls: [{ tool: "pubmed", ok: false }] });
    });

    test("an input that the schema of the tool refuses is an Error that names the field", async () => {
        const result = await run(`await tools.search_gene({ identifiers: [] });`);

        expect(result.ok).toBe(false);
        expect(result.error).toContain("search_gene: identifiers:");
        expect(result.calls).toEqual([{ tool: "search_gene", ok: false }]);
    });

    test("describe gives the full description and the input type of one tool", async () => {
        const result = await run(`return await describe("search_gene");`);

        expect(result.value).toContain("Batch up to 200 identifiers.");
        expect(result.value).toContain("identifiers: Array<string>");
    });

    test("each call of a script gets its own invocation id, also two calls in parallel", async () => {
        const echo = defineTool({
            id: "echo_id",
            description: "Give the invocation id.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: (_input, ctx) => Promise.resolve(ok({ id: ctx.invocationId })),
        });

        const result = await run(`const both = await Promise.all([tools.echo_id({}), tools.echo_id({})]); return both.map((r) => r.id);`, [echo]);

        expect(result.value).toEqual(["test-tool-call:1", "test-tool-call:2"]);
    });

    test("a cancel of the call rejects with the abort, and gives no result", async () => {
        const controller = new AbortController();
        controller.abort();
        const ctx = { ...makeToolContext().ctx, signal: controller.signal };

        const rejected = await createRunScriptTool([pubmed])
            .execute({ code: `return 1;` }, ctx)
            .then(
                () => undefined,
                (error: unknown) => error,
            );

        expect(rejected).toBeInstanceOf(DOMException);
        expect(rejected instanceof DOMException ? rejected.name : "").toBe("AbortError");
    });

    test("a script runtime with a wasm path loads the VM from that path", async () => {
        const tool = createRunScriptTool([pubmed], { wasmPath: "/no/such/dir/quickjs.wasm" });

        const result = (await tool.execute({ code: "return 1;" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.ok).toBe(false);
        expect(result.error).toContain("/no/such/dir/quickjs.wasm");
    });

    test("a call whose result carries pictures is an Error that tells to call the tool directly", async () => {
        const renderFigure = defineTool({
            id: "render_figure",
            description: "Render a figure.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () => Promise.resolve(ok(withToolResultImage({ caption: "volcano" }, { base64: "iVBORw0KGgo=", mediaType: "image/png" }))),
        });

        const result = await run(`try { await tools.render_figure({}); } catch (e) { text(e.message); }`, [renderFigure]);

        expect(result).toEqual({
            ok: true,
            output: "render_figure: the result holds pictures, and a script cannot carry pictures. Call render_figure directly, not from a script.",
            calls: [{ tool: "render_figure", ok: false }],
        });
    });

    test("an uncaught error ends the script and reports its kind", async () => {
        const result = await run(`throw new Error("no answer");`);

        expect(result.ok).toBe(false);
        expect(result.error).toContain("no answer");
    });

    test("the description gives each tool its first sentence and its input signature, with no other prose", () => {
        const { description } = createRunScriptTool([searchGene, pubmed]);

        expect(description).toContain("/** Resolve gene identifiers against Ensembl. */\nsearch_gene(args: {");
        expect(description).toContain("identifiers: Array<string>;");
        expect(description).toContain("/** Search PubMed. */\npubmed(args: {");
        expect(description).not.toContain("Batch up to 200 identifiers.");
    });
});

describe("run_script with a scratch directory", () => {
    const THREAD = "thread-1";
    let root: string;
    let events: SessionProvenanceEvent[];

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "run-script-"));
        mkdirSync(join(root, "runs/r1/s1/output"), { recursive: true });
        writeFileSync(join(root, "runs/r1/s1/output/de.csv"), "gene,padj\nTP53,0.001\nFLT3,0.2\nKIT,0.03\n");
        events = [];
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    function setup(): { tool: Tool; ctx: ToolContext; emitted: unknown[] } {
        const resolveWorkspaceRoot = (): Promise<string> => Promise.resolve(root);
        const scratch = createScriptScratch({
            resolveWorkspaceRoot,
            sessionDir: conversationSessionDir,
            provenance: { emitSessionEvent: (event) => events.push(event) },
        });
        const fileTools = createScriptFileTools({ workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot }), resolveWorkspaceRoot, scratch });
        const { ctx, emitted } = makeToolContext();
        const session = makeSession({ scope: { kind: "analysis", analysisId: "analysis-001", threadId: THREAD } });
        return { tool: createRunScriptTool([...fileTools, pubmed], {}, { scratch }), ctx: { ...ctx, invocationId: "toolu_1", session }, emitted };
    }

    const code = `
        const table = await tools.read_table({ path: "runs/r1/s1/output/de.csv" });
        const top = table.rows.filter((row) => row.padj < 0.05);
        await tools.write_derived({ name: "top.csv", rows: top });
        return top.length;
    `;

    test("saves the script, derives the file, and gives both paths", async () => {
        const { tool, ctx } = setup();

        const result = (await tool.execute({ description: "Significant genes", code }, ctx))._unsafeUnwrap();

        const dir = conversationSessionDir(THREAD);
        expect(result).toMatchObject({ ok: true, value: 2, script: `${dir}/scripts/toolu_1.js`, files: [`${dir}/derived/top.csv`] });
        expect(readFileSync(join(root, dir, "scripts/toolu_1.js"), "utf8")).toBe(code);
        expect(readFileSync(join(root, dir, "derived/top.csv"), "utf8")).toBe("gene,padj\nTP53,0.001\nKIT,0.03\n");
    });

    test("streams each nested call under the run_script call, and shows the derived file and the script in one card", async () => {
        const { tool, ctx, emitted } = setup();

        (await tool.execute({ description: "Significant genes", code }, ctx))._unsafeUnwrap();

        const source = { agentId: RUN_SCRIPT_TOOL_ID, callPath: ["conversation-agent", RUN_SCRIPT_TOOL_ID], invocationId: "toolu_1" };
        expect(emitted).toContainEqual(
            expect.objectContaining({ type: "tool-started", source, toolUseId: "toolu_1:1", name: "read_table", detail: "runs/r1/s1/output/de.csv" }),
        );
        expect(emitted).toContainEqual(expect.objectContaining({ type: "tool-finished", source, toolUseId: "toolu_1:1", outcome: "ok", detail: "3 rows" }));
        expect(emitted).toContainEqual(
            expect.objectContaining({ type: "tool-finished", source, toolUseId: "toolu_1:2", name: "write_derived", outcome: "ok" }),
        );
        const parts = emitted.filter((event) => z.object({ type: z.string() }).safeParse(event).data?.type.startsWith("data-") === true);
        const dir = conversationSessionDir(THREAD);
        expect(parts).toMatchObject([
            { type: "data-subagent-activity", data: { toolCallId: "toolu_1", entries: [{ tool: "read_table" }, { tool: "write_derived" }] } },
            {
                type: "data-file-reference",
                data: { title: "Significant genes", files: [{ path: `${dir}/derived/top.csv` }, { path: `${dir}/scripts/toolu_1.js` }] },
            },
        ]);
    });

    test("the fold of the call record gives provenance the script, the table it read, and the file it derived", async () => {
        const { tool, ctx } = setup();

        const result = (await tool.execute({ code }, ctx))._unsafeUnwrap();
        tool.foldCallRecord?.(readToolCallRecord(result));

        const dir = conversationSessionDir(THREAD);
        expect(events).toMatchObject([
            {
                type: "run-script",
                analysisId: "analysis-001",
                threadId: THREAD,
                invocationId: "toolu_1",
                script: { path: `${dir}/scripts/toolu_1.js` },
                reads: [{ path: "runs/r1/s1/output/de.csv" }],
                writes: [{ path: `${dir}/derived/top.csv` }],
                tools: ["read_table", "write_derived"],
                ok: true,
            },
        ]);
    });

    test("the description names the call, and the result names the tools that the script called", () => {
        const { tool } = setup();

        expect(tool.describeCall?.({ description: "Significant genes", code })).toBe("Significant genes");
        expect(tool.describeResult?.({ description: "Significant genes", code }, { ok: true, output: "", calls: [{ tool: "read_table", ok: true }] })).toBe(
            "Significant genes (read_table)",
        );
    });
});

describe("withRunScript", () => {
    const agent: AgentDefinition = { id: "a", systemPrompt: "s", model: "m", tools: [pubmed], maxIterations: 3 };

    test("adds run_script after the tools of the agent", () => {
        const expanded = withRunScript({ ...agent, scriptTools: [searchGene] });

        expect(expanded.tools.map((tool) => tool.id)).toEqual(["pubmed", RUN_SCRIPT_TOOL_ID]);
    });

    test("leaves an agent with no script tools as it is", () => {
        expect(withRunScript(agent)).toBe(agent);
        expect(withRunScript({ ...agent, scriptTools: [] }).tools).toEqual([pubmed]);
    });

    test("refuses a script tool that must run as its own durable step", () => {
        const exec: Tool = { ...pubmed, ownStep: true };

        expect(() => withRunScript({ ...agent, scriptTools: [exec] })).toThrow("the script tool pubmed of agent a must run as its own durable step");
    });

    test("refuses a script tool that asks an approval", () => {
        const asking = defineTool({
            id: "write_note",
            description: "Write a note.",
            inputSchema: z.object({ text: z.string() }),
            describeCall: "none",
            approval: () => ({ title: "Write", command: "write" }),
            execute: () => Promise.resolve(ok({ written: true })),
        });

        expect(() => withRunScript({ ...agent, scriptTools: [asking] })).toThrow("the script tool write_note of agent a asks an approval or starts a workflow");
    });
});

describe("run_script in the loop", () => {
    test("a request declares run_script and not the script tools, and the script result reaches the next request", async () => {
        const model = scriptedModel([
            callTools(toolCall("c1", RUN_SCRIPT_TOOL_ID, { code: 'const r = await tools.pubmed({ query: "FOXP3" }); return r.totalFound;' })),
            reply([text("Three papers.")]),
        ]);
        const agent: AgentDefinition = { id: "a", systemPrompt: "s", model: "m", tools: [searchGene], scriptTools: [pubmed], maxIterations: 3 };

        const result = await runLoop(agent, [], makeSession(), {
            provider: model.provider,
            signal: new AbortController().signal,
            emit: () => undefined,
            turnInput: [{ role: "user", content: "How many?" }],
        });

        expect(model.calls[0]?.tools?.map((tool) => tool.name)).toEqual(["search_gene", RUN_SCRIPT_TOOL_ID]);
        expect(JSON.stringify(model.calls[1]?.prompt)).toContain('"value":3');
        expect(result.steps[0]?.calls[0]).toMatchObject({
            toolName: RUN_SCRIPT_TOOL_ID,
            output: { outcome: "ok", value: { ok: true, value: 3, calls: [{ tool: "pubmed", ok: true }] } },
        });
    });
});
