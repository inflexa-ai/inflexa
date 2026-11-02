import { describe, expect, test } from "bun:test";

import { ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../../providers/__fixtures__/session.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../testing.js";
import { defineTool } from "../../tools/define-tool.js";
import { runLoop } from "../run-loop.js";
import { aliasedToolName } from "../tool-name-repair.js";
import type { AgentDefinition } from "../types.js";

const declared = new Set(["read_file", "run_script", "search_gene"]);

describe("aliasedToolName", () => {
    test("one lowercase word before a declared id names that tool", () => {
        expect(aliasedToolName("art_read_file", declared)).toBe("read_file");
        expect(aliasedToolName("round_run_script", declared)).toBe("run_script");
    });

    test("a declared name, an unknown rest, and a word that is not lowercase letters name no tool", () => {
        expect(aliasedToolName("read_file", declared)).toBeUndefined();
        expect(aliasedToolName("art_write_file", declared)).toBeUndefined();
        expect(aliasedToolName("Art_read_file", declared)).toBeUndefined();
        expect(aliasedToolName("mcp__x__read_file", declared)).toBeUndefined();
        expect(aliasedToolName("_read_file", declared)).toBeUndefined();
    });
});

describe("the loop repairs an alias", () => {
    test("a call of art_search_gene runs search_gene", async () => {
        const searchGene = defineTool({
            id: "search_gene",
            description: "Resolve gene identifiers.",
            inputSchema: z.object({ identifiers: z.array(z.string()) }),
            view: "none",
            describeCall: "none",
            execute: ({ identifiers }) => Promise.resolve(ok({ genes: identifiers })),
        });
        const agent: AgentDefinition = { id: "a", systemPrompt: "s", model: "m", tools: [searchGene], maxIterations: 3 };
        const model = scriptedModel([callTools(toolCall("c1", "art_search_gene", { identifiers: ["TP53"] })), reply([text("Done.")])]);

        const result = await runLoop(agent, [], makeSession(), {
            provider: model.provider,
            signal: new AbortController().signal,
            emit: () => undefined,
            turnInput: [{ role: "user", content: "Resolve TP53." }],
        });

        expect(result.steps[0]?.calls[0]).toMatchObject({ toolName: "search_gene", output: { outcome: "ok", value: { genes: ["TP53"] } } });
    });
});
