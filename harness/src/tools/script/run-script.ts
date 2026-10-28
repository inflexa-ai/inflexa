/**
 * `run_script` — the agent writes one JavaScript script that calls its script tools as functions.
 *
 * The script runs in QuickJS (`@earendil-works/pi-codemode`), a WASM VM in a worker thread. The VM has no files, no
 * network, and no timers. Its only capability is a call of a script tool, and each call runs the `execute` of that
 * tool with the context of the `run_script` call. Only what the script prints or returns reaches the model, thus a
 * script can join and filter large lookup results before the model reads them.
 *
 * A script tool asks no approval and writes nothing, thus the whole script is one durable step: a replay returns the
 * cached result and runs no lookup again.
 */

import { CodemodeSandbox, renderToolSample, renderToolSignature, type CodemodeTool } from "@earendil-works/pi-codemode";
import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { parseJsonAs } from "../../lib/parse-json.js";
import { parseUnknownRecord, UnknownArraySchema } from "../../lib/unknown-containers.js";
import { defineTool, type Tool, type ToolContext, type ToolError } from "../define-tool.js";

export const RUN_SCRIPT_TOOL_ID = "run_script";

/** The deadline of one script, for each lookup in it together. */
const SCRIPT_TIMEOUT_MS = 180_000;

/** The heap of the VM. A script holds lookup results and small tables, not datasets. */
const SCRIPT_MEMORY_BYTES = 128 * 1024 * 1024;

/** The text of a result that reaches the model. A longer output keeps its head and its tail. */
const MAX_RESULT_CHARS = 24_000;

const inputSchema = z.object({
    code: z
        .string()
        .min(1)
        .describe(
            "The body of an async JavaScript function. Call a tool as `await tools.<name>({...})`, print with `text(value)` or `console.log`, and `return` a value.",
        ),
});

export type ScriptCall = { readonly tool: string; readonly ok: boolean };

export type RunScriptOutput = {
    readonly ok: boolean;
    /** What the script printed, in order. */
    readonly output: string;
    /** The JSON of the returned value. Absent for a failed script and for a script that returned nothing. */
    readonly value?: unknown;
    /** The kind and the message of the failure of a failed script. */
    readonly error?: string;
    /** Each tool call of the script, in the order of the calls. */
    readonly calls: readonly ScriptCall[];
};

/** The first sentence of a description, for the catalog line of a tool. */
function firstSentence(description: string): string {
    const line = description.split("\n")[0] ?? "";
    const stop = line.indexOf(". ");
    return stop === -1 ? line : line.slice(0, stop + 1);
}

function bounded(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text;
    const half = MAX_RESULT_CHARS / 2;
    return `${text.slice(0, half)}\n[... ${text.length - MAX_RESULT_CHARS} characters cut ...]\n${text.slice(-half)}`;
}

/** The JSON form of a tool result: the plain data, without the symbol keys of the loop. */
function plainJson(value: unknown): unknown {
    return value === undefined ? null : parseJsonAs(JSON.stringify(value), z.json());
}

function describeTool(tool: Tool): string {
    return renderToolSample({ name: tool.id, description: tool.description, inputSchema: tool.jsonSchema });
}

function issuesOf(error: z.ZodError): string {
    return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

/**
 * A script tool as the VM calls it. Each call gets its own invocation id, `<id of run_script>:<n>` in call order: a
 * tool keys what it stores by its invocation id (`web_fetch` keeps the cut text of a page under it), thus two calls of
 * one script must not share it. The script is one step, thus a replay calls nothing and the ids stay as recorded.
 */
function scriptToolOf(tool: Tool, ctx: ToolContext, calls: ScriptCall[], nextInvocationId: () => string): CodemodeTool {
    return {
        name: tool.id,
        description: tool.description,
        inputSchema: tool.jsonSchema,
        execute: async (args, { signal }) => {
            const parsed = tool.inputSchema.safeParse(args);
            if (!parsed.success) {
                calls.push({ tool: tool.id, ok: false });
                throw new Error(`${tool.id}: ${issuesOf(parsed.error)}`);
            }
            const invocationId = nextInvocationId();
            const result = await tool.execute(parsed.data, { ...ctx, invocationId, signal: AbortSignal.any([ctx.signal, signal]) });
            calls.push({ tool: tool.id, ok: result.isOk() });
            if (result.isErr()) throw new Error(`${tool.id}: ${result.error.error}`);
            return plainJson(result.value);
        },
    };
}

/** A JSON schema without its prose: the types and the constraints stay, the descriptions and the examples go. */
function withoutProse(schema: unknown): unknown {
    const array = UnknownArraySchema.safeParse(schema);
    if (array.success) return array.data.map(withoutProse);
    const record = parseUnknownRecord(schema);
    if (record === undefined) return schema;
    return Object.fromEntries(
        Object.entries(record)
            .filter(([key]) => key !== "description" && key !== "examples")
            .map(([key, value]) => [key, withoutProse(value)]),
    );
}

/** One catalog entry: the first sentence of the description, then the input signature with no prose. */
function catalogEntry(tool: Tool): string {
    const signature = renderToolSignature({ name: tool.id, inputSchema: parseUnknownRecord(withoutProse(tool.jsonSchema)) ?? {} });
    return `/** ${firstSentence(tool.description)} */\n${signature}`;
}

/** The description of the tool: the script API, then one catalog entry for each script tool. */
function descriptionOf(tools: readonly Tool[]): string {
    const catalog = tools.map(catalogEntry).join("\n");
    return (
        "Run a JavaScript script that calls the tools below as functions, in a sandbox with no files and no network. " +
        "Use it for lookups: call several tools in parallel with Promise.all, filter and join their results, and print only what you need. " +
        "Only the printed output and the returned value come back to you.\n" +
        "API: `await tools.<name>(args)` returns the JSON result of the tool and throws an Error on a failed call. " +
        '`await describe("<name>")` returns the full description of a tool, with the meaning of each argument. ' +
        "`text(value)` and `console.log` print. `return` gives a value. There are no timers, no fetch, and no modules.\n" +
        `Tools (the result is the JSON that the tool returns):\n${catalog}`
    );
}

/** The `run_script` tool over the script tools of an agent. */
export function createRunScriptTool(scriptTools: readonly Tool[]): Tool<z.infer<typeof inputSchema>, RunScriptOutput> {
    const byId = new Map(scriptTools.map((tool) => [tool.id, tool]));
    return defineTool({
        id: RUN_SCRIPT_TOOL_ID,
        description: descriptionOf(scriptTools),
        inputSchema,
        describeCall: "none",
        describeResult: (_input, result) => (result.calls.length === 0 ? undefined : result.calls.map((call) => call.tool).join(", ")),
        execute: async ({ code }, ctx): Promise<Result<RunScriptOutput, ToolError>> => {
            const calls: ScriptCall[] = [];
            let started = 0;
            const nextInvocationId = (): string => `${ctx.invocationId}:${++started}`;
            const sandbox = new CodemodeSandbox({
                tools: scriptTools.map((tool) => scriptToolOf(tool, ctx, calls, nextInvocationId)),
                globals: [
                    {
                        name: "describe",
                        execute: (name) => {
                            const tool = typeof name === "string" ? byId.get(name) : undefined;
                            if (tool === undefined) throw new Error(`no script tool ${JSON.stringify(name)}; the tools are ${[...byId.keys()].join(", ")}`);
                            return describeTool(tool);
                        },
                    },
                ],
                timeoutMs: SCRIPT_TIMEOUT_MS,
                memoryLimitBytes: SCRIPT_MEMORY_BYTES,
            });
            try {
                const result = await sandbox.execute(code, { signal: ctx.signal });
                // A cancel of the call is no result of the script: the loop must see the abort and end the run.
                ctx.signal.throwIfAborted();
                const output = bounded(
                    result.output
                        .filter((item) => item.type === "text")
                        .map((item) => item.text)
                        .join("\n"),
                );
                if (!result.ok) return ok({ ok: false, output, error: `${result.error.kind}: ${result.error.message}`, calls });
                return ok({ ok: true, output, value: result.value === undefined ? undefined : plainJson(result.value), calls });
            } finally {
                await sandbox.close();
            }
        },
    });
}
