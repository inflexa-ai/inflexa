import { describe, expect, test } from "bun:test";

import { err, ok } from "neverthrow";
import { z } from "zod";

import { runLoop, withRunScript } from "../../../loop/run-loop.js";
import type { AgentDefinition } from "../../../loop/types.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../../testing.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { defineTool, type Tool } from "../../define-tool.js";
import { createRunScriptTool, RUN_SCRIPT_TOOL_ID, type RunScriptOutput } from "../run-script.js";

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

    test("refuses a script tool that keeps a call record", () => {
        const recording: Tool = { ...pubmed, foldCallRecord: () => undefined };

        expect(() => withRunScript({ ...agent, scriptTools: [recording] })).toThrow(
            "the script tool pubmed of agent a keeps a call record, which a script drops",
        );
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
