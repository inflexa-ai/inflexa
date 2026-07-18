import { describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import { err, ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { runAgent } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import type { AgentDefinition } from "./types.js";

const GO: ReadonlyArray<{ role: "user"; content: string }> = [{ role: "user", content: "go" }];

const SYNTHESIS = { runId: "run-1", findings: ["finding one", "finding two"] };

/**
 * A tool whose `synthesis` argument is an object and whose `note` argument is a
 * genuine string, plus a semantic check the schema cannot express (a synthesis
 * must carry at least one finding). `seen` records exactly what `execute` was
 * handed — repair is only correct if the tool receives parsed data.
 */
function submitTool(): { tool: Tool; seen: unknown[] } {
    const seen: unknown[] = [];
    const tool = defineTool({
        id: "submit",
        description: "Submit a synthesis.",
        inputSchema: z.object({
            synthesis: z.object({ runId: z.string(), findings: z.array(z.string()) }),
            note: z.string().optional(),
        }),
        execute: async (input) => {
            seen.push(input);
            if (input.synthesis.findings.length === 0) {
                return err({ error: "synthesis must contain at least one finding", retryable: true });
            }
            return ok({ accepted: input.synthesis.runId });
        },
    });
    return { tool, seen };
}

function agentDef(tools: Tool[]): AgentDefinition {
    return { id: "test-agent", systemPrompt: "You are a test agent.", model: "claude-test", tools, maxIterations: 4 };
}

/** Run one tool call with `input` and return the resulting tool-result part. */
async function callWith(tool: Tool, input: unknown): Promise<ToolResultPart> {
    const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", tool.id, input)], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

    const { messages } = await runAgent(agentDef([tool]), GO, makeSession(), {
        provider,
        signal: new AbortController().signal,
        emit: () => {},
        runStep: passthroughStep,
    });

    const toolMessage = messages[2] as Extract<ModelMessage, { role: "tool" }>;
    expect(toolMessage.role).toBe("tool");
    return (toolMessage.content as ToolResultPart[])[0]!;
}

function errorText(result: ToolResultPart): string {
    expect(result.output.type).toBe("error-text");
    return result.output.type === "error-text" ? result.output.value : "";
}

describe("runAgent — tool-input repair", () => {
    it("repairs a complete JSON argument carrying trailing function-call markup", async () => {
        const { tool, seen } = submitTool();

        const result = await callWith(tool, { synthesis: `${JSON.stringify(SYNTHESIS)}</parameter>\n</invoke>` });

        expect(result.output).toEqual({ type: "json", value: { accepted: "run-1" } });
        expect(seen).toEqual([{ synthesis: SYNTHESIS }]);
    });

    it("repairs a fenced JSON argument", async () => {
        const { tool, seen } = submitTool();

        const result = await callWith(tool, { synthesis: `\`\`\`json\n${JSON.stringify(SYNTHESIS)}\n\`\`\`` });

        expect(result.output).toEqual({ type: "json", value: { accepted: "run-1" } });
        expect(seen).toEqual([{ synthesis: SYNTHESIS }]);
    });

    it("repairs genuine double encoding", async () => {
        const { tool, seen } = submitTool();

        const result = await callWith(tool, { synthesis: JSON.stringify(SYNTHESIS) });

        expect(result.output).toEqual({ type: "json", value: { accepted: "run-1" } });
        expect(seen).toEqual([{ synthesis: SYNTHESIS }]);
    });

    it("still rejects a repaired payload that fails the schema — repair does not bypass validation", async () => {
        const { tool, seen } = submitTool();

        const result = await callWith(tool, { synthesis: '{"runId":42,"findings":["a"]}</parameter>\n</invoke>' });

        expect(errorText(result)).toContain("input validation failed");
        expect(seen).toEqual([]);
    });

    it("still runs the tool's own semantic check on a repaired payload", async () => {
        const { tool, seen } = submitTool();

        const result = await callWith(tool, { synthesis: '{"runId":"run-1","findings":[]}</parameter>\n</invoke>' });

        expect(errorText(result)).toContain("at least one finding");
        // The tool ran — validation was reachable — and rejected the content itself.
        expect(seen).toEqual([{ synthesis: { runId: "run-1", findings: [] } }]);
    });

    it("leaves a legitimate string argument holding JSON-looking text untouched", async () => {
        const { tool, seen } = submitTool();

        const result = await callWith(tool, { synthesis: SYNTHESIS, note: '{"looks":"like json"}' });

        expect(result.output).toEqual({ type: "json", value: { accepted: "run-1" } });
        expect(seen).toEqual([{ synthesis: SYNTHESIS, note: '{"looks":"like json"}' }]);
    });

    it("falls through to an error result for a leading function-call fragment", async () => {
        const { tool, seen } = submitTool();

        const result = await callWith(tool, { synthesis: '\n<parameter name="runId">fb0f43f5-1234' });

        const text = errorText(result);
        expect(text).toContain("input validation failed");
        expect(text).toContain("synthesis");
        // No speculative hint for a string that parses under no interpretation.
        expect(text).not.toContain("JSON-encoded string");
        expect(seen).toEqual([]);
    });

    it("attaches the wrapper hint — not the double-encoding hint — when the repaired value fails the schema", async () => {
        const { tool } = submitTool();

        const result = await callWith(tool, { synthesis: '{"runId":42,"findings":["a"]}</parameter>\n</invoke>' });

        const text = errorText(result);
        expect(text).toContain("extra content wrapped around");
        expect(text).not.toContain("JSON-encoded string");
    });

    it("attaches the double-encoding hint when the string parses in full but fails the schema", async () => {
        const { tool } = submitTool();

        const result = await callWith(tool, { synthesis: JSON.stringify({ runId: 42, findings: ["a"] }) });

        expect(errorText(result)).toContain("JSON-encoded string");
    });

    it("does not mutate the tool call's input object", async () => {
        const { tool } = submitTool();
        const raw = `${JSON.stringify(SYNTHESIS)}</parameter>\n</invoke>`;
        const input = { synthesis: raw };

        await callWith(tool, input);

        expect(input.synthesis).toBe(raw);
    });
});
