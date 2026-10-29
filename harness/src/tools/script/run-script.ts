/**
 * `run_script` — the agent writes one JavaScript script that calls its script tools as functions.
 *
 * The script runs in QuickJS (`@earendil-works/pi-codemode`), a WASM VM in a worker thread. The VM has no files, no
 * network, and no timers. Its only capability is a call of a script tool, and each call runs the `execute` of that
 * tool with the context of the `run_script` call. Only what the script prints or returns reaches the model, thus a
 * script can join and filter large lookup results and tables before the model reads them.
 *
 * The whole script is one durable step: a replay returns the cached result and runs no lookup again. A step that
 * did not complete runs the whole script again, thus a script tool that writes must accept the same write again.
 *
 * Each nested call streams its start and its end under the `run_script` call, thus a surface shows what the script
 * does while it runs. With a scratch directory, the script is saved before it runs, each derived file is shown to
 * the user in one file card with the script, and the files that the script read and wrote reach provenance.
 */

import {
    CodemodeSandbox,
    loadQuickJSWasm,
    renderToolSample,
    renderToolSignature,
    schemaToType,
    type CodemodeError,
    type CodemodeSandboxOptions,
    type CodemodeTool,
} from "@earendil-works/pi-codemode";
import { AsyncLocalStorage } from "node:async_hooks";

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import type { ChatFrame, ChatPartFrame, EventSource } from "../../contracts/chat-events.js";
import { createSubAgentActivityTracker } from "../../contracts/subagent-activity.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { parseJsonAs } from "../../lib/parse-json.js";
import { parseUnknownRecord, UnknownArraySchema } from "../../lib/unknown-containers.js";
import { computeDetail, computeResultDetail } from "../../loop/tool-detail.js";
import { buildFileReferenceCardData, MAX_FILES } from "../../memory/card-builders.js";
import {
    defineTool,
    readToolCallRecord,
    readToolResultImages,
    withToolCallRecord,
    type Tool,
    type ToolContext,
    type ToolError,
    type WithToolCallRecord,
} from "../define-tool.js";
import { ScriptFileEffectSchema } from "./file-tools.js";
import { recordScriptRun, type ScriptFailure } from "./metrics.js";
import type { ScratchFile, ScriptRead, ScriptRunRecord, ScriptScratch } from "./scratch.js";

export const RUN_SCRIPT_TOOL_ID = "run_script";

/** The deadline of one script, for each lookup in it together. */
const SCRIPT_TIMEOUT_MS = 180_000;

/** The heap of the VM. A script holds lookup results and tables of up to the read cap, not datasets. */
const SCRIPT_MEMORY_BYTES = 256 * 1024 * 1024;

/** The text of a result that reaches the model. A longer output keeps its head and its tail. */
const MAX_RESULT_CHARS = 24_000;

/** The least time between two live copies of the nested calls of a script. */
const LIVE_ACTIVITY_INTERVAL_MS = 500;

const inputSchema = z.object({
    description: z.string().max(200).optional().describe("One short line that tells the user what the script does, for example 'Top 20 genes by padj'."),
    code: z
        .string()
        .min(1)
        .describe(
            "The body of an async JavaScript function. Call a tool as `await tools.<name>({...})`, print with `text(value)` or `console.log`, and `return` a value.",
        ),
});

/**
 * Where the VM of a script comes from. A host that runs the harness from `node_modules` gives nothing, and the VM loads
 * its wasm and its worker from there. A bundled host, for example a Bun single-file binary, has no such files on disk:
 * it embeds `tools/script/quickjs.wasm` and the entry `tools/script/codemode-worker.js` of the harness, and gives their
 * embedded paths.
 */
export type ScriptRuntime = {
    readonly wasmPath?: string;
    readonly workerUrl?: string | URL;
};

/** What `run_script` needs beside its tools: the scratch directory of the session, and the logger. */
export type RunScriptOptions = {
    readonly scratch?: ScriptScratch;
    readonly logger?: Logger;
};

export type ScriptCall = { readonly tool: string; readonly ok: boolean };

/** The call record of one nested call, kept for a tool that folds its records. */
type NestedRecord = { readonly tool: string; readonly record: unknown };

/**
 * The call record of a script: the run, for the provenance of the scratch directory, and the record of each nested
 * call whose tool folds records, in call order. A replay folds the same records in the same order, thus the state
 * that a fold rebuilds is the same as in a direct call.
 */
type RunScriptRecord = { readonly run?: ScriptRunRecord; readonly nested: readonly NestedRecord[] };

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
    /** The saved script, analysis-root-relative. Absent with no scratch directory. */
    readonly script?: string;
    /** Each file that the script derived, analysis-root-relative. */
    readonly files?: readonly string[];
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
    return renderToolSample({ name: tool.id, description: tool.description, inputSchema: inputSchemaOf(tool), outputSchema: tool.outputJsonSchema });
}

function issuesOf(error: z.ZodError): string {
    return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

/** What the nested calls of one script collect: the calls, and the files that the calls read and wrote. */
type ScriptState = {
    readonly code: string;
    readonly calls: ScriptCall[];
    readonly reads: ScriptRead[];
    readonly writes: ScratchFile[];
    readonly nested: NestedRecord[];
    readonly nextInvocationId: () => string;
    /** The source of the frames of a nested call: one level below the `run_script` call. */
    readonly source: EventSource;
    readonly observe: (frame: ChatFrame) => void;
};

type LiveActivity = {
    /** Take the newest activity part of the script. */
    update(part: ChatPartFrame): void;
    /** Send nothing more, and wait for each copy in flight. */
    close(): Promise<void>;
};

/**
 * The live copies of the activity part of one script, so a reader sees each nested call while the script runs. A copy
 * is transient, and the part that the call emits at its end is the one that a stored display keeps. Each copy holds
 * each entry so far, thus at most one copy goes in each interval. A copy that the interval holds back goes at the end
 * of the interval, thus a long nested call shows before it ends.
 */
function createLiveActivity(emit: ToolContext["emit"], log: Logger, intervalMs: number): LiveActivity {
    let latest: ChatPartFrame | null = null;
    let lastSentMs = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const inFlight = new Set<Promise<void>>();
    const send = (): void => {
        timer = undefined;
        if (closed || latest === null) return;
        lastSentMs = Date.now();
        const part = latest;
        const sent = (async () => {
            try {
                await emit({ type: part.type, data: part, transient: true });
            } catch (err) {
                log.warn("a live copy of the nested calls did not reach the stream", log.errorFields(err));
            }
        })();
        inFlight.add(sent);
        void sent.finally(() => inFlight.delete(sent));
    };
    return {
        update(part) {
            latest = part;
            if (closed || timer !== undefined) return;
            const wait = lastSentMs + intervalMs - Date.now();
            if (wait <= 0) send();
            // oxlint-disable-next-line eslint-js/no-restricted-syntax -- `close` clears it, and the call runs `close` in its `finally`, thus it ends with the call.
            else timer = setTimeout(send, wait);
        },
        async close() {
            closed = true;
            clearTimeout(timer);
            await Promise.all(inFlight);
        },
    };
}

/** Keep the files of the call record of one nested call. A record of another shape carries no file. */
function collectEffect(state: ScriptState, value: unknown): void {
    const effect = ScriptFileEffectSchema.safeParse(readToolCallRecord(value));
    if (!effect.success) return;
    state.reads.push(...(effect.data.reads ?? []));
    state.writes.push(...(effect.data.writes ?? []));
}

/**
 * A script tool as the VM calls it. Each call gets its own invocation id, `<id of run_script>:<n>` in call order: a
 * tool keys what it stores by its invocation id (`web_fetch` keeps the cut text of a page under it), thus two calls of
 * one script must not share it. The script is one step, thus a replay calls nothing and the ids stay as recorded.
 *
 * The script gets the JSON of a result, and the JSON has no pictures. Thus a result with pictures is a failed call: the
 * script would otherwise read the result as complete.
 */
function scriptToolOf(tool: Tool, ctx: ToolContext, state: ScriptState, log: Logger, inCallContext: CallContext): CodemodeTool {
    return {
        name: tool.id,
        description: tool.description,
        inputSchema: inputSchemaOf(tool),
        outputSchema: tool.outputJsonSchema,
        execute: (args, options) => inCallContext(() => runNestedCall(tool, ctx, state, log, args, options.signal)),
    };
}

/** Runs a function in the async context of the `run_script` call. See {@link createRunScriptTool}. */
type CallContext = <R>(fn: () => R) => R;

async function runNestedCall(tool: Tool, ctx: ToolContext, state: ScriptState, log: Logger, args: unknown, signal: AbortSignal): Promise<unknown> {
    const invocationId = state.nextInvocationId();
    const detail = computeDetail(tool, args, log);
    const started = performance.now();
    const startFrame = { type: "tool-started", source: state.source, toolUseId: invocationId, name: tool.id, input: args, detail } as const;
    state.observe(startFrame);
    await ctx.emit(startFrame);
    const finish = async (outcome: "ok" | "error", finishedDetail: string | undefined): Promise<void> => {
        state.calls.push({ tool: tool.id, ok: outcome === "ok" });
        const endFrame = {
            type: "tool-finished",
            source: state.source,
            toolUseId: invocationId,
            name: tool.id,
            outcome,
            durationMs: Math.round(performance.now() - started),
            detail: finishedDetail,
        } as const;
        state.observe(endFrame);
        await ctx.emit(endFrame);
    };

    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
        await finish("error", detail);
        throw new Error(`${tool.id}: ${issuesOf(parsed.error)}`);
    }
    const result = await tool.execute(parsed.data, {
        ...ctx,
        invocationId,
        signal: AbortSignal.any([ctx.signal, signal]),
        script: { code: state.code },
    });
    if (result.isErr()) {
        await finish("error", detail);
        throw new Error(`${tool.id}: ${result.error.error}`);
    }
    if (readToolResultImages(result.value).length > 0) {
        await finish("error", detail);
        throw new Error(`${tool.id}: the result holds pictures, and a script cannot carry pictures. Call ${tool.id} directly, not from a script.`);
    }
    collectEffect(state, result.value);
    if (tool.foldCallRecord !== undefined) {
        const record = readToolCallRecord(result.value);
        if (record !== undefined) state.nested.push({ tool: tool.id, record });
    }
    await finish("ok", computeResultDetail(tool, parsed.data, result.value, log) ?? detail);
    return plainJson(result.value);
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

/**
 * A JSON schema as a script reads it. A tool can union its real shape with the empty schema to keep its runtime parse
 * permissive (`add_block` does, thus a malformed block reaches its typed refusal). The type of such a union is
 * `unknown`, which hides the real shape, thus the empty member goes. The VM only renders the schema and validates
 * nothing, and the tool still parses each input with its own schema.
 */
function printableSchema(schema: unknown): unknown {
    const array = UnknownArraySchema.safeParse(schema);
    if (array.success) return array.data.map(printableSchema);
    const record = parseUnknownRecord(schema);
    if (record === undefined) return schema;
    let out: Record<string, unknown> = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, printableSchema(value)]));
    for (const key of ["anyOf", "oneOf"]) {
        const members = UnknownArraySchema.safeParse(out[key]);
        if (!members.success) continue;
        const shaped = members.data.filter((member) => Object.keys(parseUnknownRecord(member) ?? {}).length > 0);
        if (shaped.length === 0 || shaped.length === members.data.length) continue;
        const rest = Object.fromEntries(Object.entries(out).filter(([name]) => name !== key));
        out = shaped.length > 1 ? { ...rest, [key]: shaped } : { ...rest, ...parseUnknownRecord(shaped[0]) };
    }
    return out;
}

/** The input schema of a tool as a script reads it. See {@link printableSchema}. */
function inputSchemaOf(tool: Tool): Record<string, unknown> {
    return parseUnknownRecord(printableSchema(tool.jsonSchema)) ?? tool.jsonSchema;
}

/** The longest result type that the catalog shows. A longer type shows as `unknown`, and `describe()` gives it whole. */
const MAX_CATALOG_RESULT_TYPE_CHARS = 800;

/** One catalog entry: the first sentence of the description, then the signature with no prose. */
function catalogEntry(tool: Tool): string {
    const output = tool.outputJsonSchema === undefined ? undefined : parseUnknownRecord(withoutProse(tool.outputJsonSchema));
    const resultType = output === undefined ? "unknown" : schemaToType(output, { maxChars: MAX_CATALOG_RESULT_TYPE_CHARS });
    // pi renders a signature with no result schema as `...: Promise<unknown>;`, thus the catalog puts its capped type there.
    const untyped = renderToolSignature({ name: tool.id, inputSchema: parseUnknownRecord(withoutProse(inputSchemaOf(tool))) ?? {} });
    const signature = `${untyped.slice(0, -"unknown>;".length)}${resultType}>;`;
    return `/** ${firstSentence(tool.description)} */\n${signature}`;
}

/** The description of the tool: the script API, then one catalog entry for each script tool. */
function descriptionOf(tools: readonly Tool[]): string {
    const catalog = tools.map(catalogEntry).join("\n");
    return (
        "Run a JavaScript script that calls the tools below as functions, in a JavaScript VM on the host with no files and no network. " +
        "Use it for lookups and for light work on tables: call several tools in parallel with Promise.all, filter, join, and count their results, and print only what you need. " +
        "Only the printed output and the returned value come back to you.\n" +
        "API: `await tools.<name>(args)` returns the JSON result of the tool and throws an Error on a failed call. " +
        '`await describe("<name>")` returns the full description of a tool, with the meaning of each argument. ' +
        "`text(value)` and `console.log` print. `return` gives a value. There are no timers, no fetch, and no modules.\n" +
        `Tools (the result is the JSON that the tool returns):\n${catalog}`
    );
}

function sandboxRuntimeOf(runtime: ScriptRuntime): Pick<CodemodeSandboxOptions, "wasm" | "workerUrl"> {
    const options: Pick<CodemodeSandboxOptions, "wasm" | "workerUrl"> = {};
    if (runtime.wasmPath !== undefined) options.wasm = loadQuickJSWasm(runtime.wasmPath);
    if (runtime.workerUrl !== undefined) options.workerUrl = runtime.workerUrl;
    return options;
}

/** The failure of a script, for the metrics. The VM reports an exhausted heap as an error of the script. */
function failureOf(error: CodemodeError): ScriptFailure {
    if (error.kind === "script") return error.message.includes("out of memory") ? "memory" : "script";
    return error.kind;
}

/** The card of the files that a script derived, with the script beside them. A card holds at most ten files. */
function filesCard(
    description: string | undefined,
    writes: readonly ScratchFile[],
    script: ScratchFile | undefined,
): ReturnType<typeof buildFileReferenceCardData> {
    const files: { path: string; caption?: string }[] = [...new Map(writes.map((write) => [write.path, { path: write.path }])).values()];
    const room = script === undefined ? MAX_FILES : MAX_FILES - 1;
    const shown = files.slice(0, room);
    if (script !== undefined) shown.push({ path: script.path, caption: "The script that derived these files." });
    return buildFileReferenceCardData({ title: description ?? "Derived files", files: shown });
}

type RunScriptResult = RunScriptOutput | WithToolCallRecord<RunScriptOutput, RunScriptRecord>;

/** The `run_script` tool over the script tools of an agent. */
export function createRunScriptTool(
    scriptTools: readonly Tool[],
    runtime: ScriptRuntime = {},
    options: RunScriptOptions = {},
): Tool<z.infer<typeof inputSchema>, RunScriptResult> {
    const vm = sandboxRuntimeOf(runtime);
    const byId = new Map(scriptTools.map((tool) => [tool.id, tool]));
    const log = (options.logger ?? createNoopLogger()).named("run-script");
    const { scratch } = options;
    return defineTool({
        id: RUN_SCRIPT_TOOL_ID,
        description: descriptionOf(scriptTools),
        inputSchema,
        describeCall: ({ description }) => description,
        describeResult: ({ description }, result) => {
            const tools = result.calls.length === 0 ? undefined : result.calls.map((call) => call.tool).join(", ");
            return description === undefined ? tools : tools === undefined ? description : `${description} (${tools})`;
        },
        foldCallRecord: (record) => {
            if (record.run !== undefined) scratch?.recordRun(record.run);
            for (const entry of record.nested) {
                try {
                    byId.get(entry.tool)?.foldCallRecord?.(entry.record);
                } catch (err) {
                    log.error("the call record of a nested call did not fold", { tool: entry.tool, ...log.errorFields(err) });
                }
            }
        },
        execute: async ({ description, code }, ctx): Promise<Result<RunScriptResult, ToolError>> => {
            const startedAt = performance.now();
            const script = await scratch?.saveScript({ session: ctx.session, invocationId: ctx.invocationId, code });
            const caller = ctx.session.provenance;
            const tracker = createSubAgentActivityTracker();
            // The tracker reads the call of the script first, thus each nested call belongs to it. Only a call of the
            // root agent has an activity part: the tracker keeps no root for a deeper caller.
            tracker.track(
                {
                    type: "tool-started",
                    toolUseId: ctx.invocationId,
                    name: RUN_SCRIPT_TOOL_ID,
                    source: { agentId: caller.agentId, callPath: [...caller.callPath] },
                },
                Date.now(),
            );
            const tracked: { part: ChatPartFrame | null } = { part: null };
            const live = createLiveActivity(ctx.emit, log, LIVE_ACTIVITY_INTERVAL_MS);
            let started = 0;
            const state: ScriptState = {
                code,
                calls: [],
                reads: [],
                writes: [],
                nested: [],
                nextInvocationId: () => `${ctx.invocationId}:${++started}`,
                source: { agentId: RUN_SCRIPT_TOOL_ID, callPath: [...caller.callPath, RUN_SCRIPT_TOOL_ID], invocationId: ctx.invocationId },
                observe: (frame) => {
                    const part = tracker.track(frame, Date.now());
                    if (part === null) return;
                    tracked.part = part;
                    live.update(part);
                },
            };
            // The VM calls a tool from a message event of its worker, and such an event runs outside the async context
            // of this call. A nested call runs in the snapshot of this context, thus it sees what the call sees, for
            // example the durable step of the call, which DBOS keeps in an AsyncLocalStorage.
            const inCallContext = AsyncLocalStorage.snapshot();
            const sandbox = new CodemodeSandbox({
                tools: scriptTools.map((tool) => scriptToolOf(tool, ctx, state, log, inCallContext)),
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
                ...vm,
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
                const failure = result.ok ? "none" : failureOf(result.error);
                recordScriptRun(caller.agentId, failure);
                log.info("a script ran", {
                    invocationId: ctx.invocationId,
                    failure,
                    durationMs: Math.round(performance.now() - startedAt),
                    calls: state.calls.length,
                    reads: state.reads.length,
                    writes: state.writes.length,
                });

                await live.close();
                if (tracked.part !== null) await ctx.emit({ type: tracked.part.type, data: tracked.part });
                if (state.writes.length > 0) {
                    const card = filesCard(description, state.writes, script);
                    if (card !== null) await ctx.emit({ type: "data-file-reference", source: caller, data: card });
                }

                const run: ScriptRunRecord = {
                    analysisId: ctx.session.scope.analysisId,
                    threadId: ctx.session.scope.threadId,
                    invocationId: ctx.invocationId,
                    script,
                    reads: state.reads,
                    writes: state.writes,
                    tools: state.calls.map((call) => call.tool),
                    ok: result.ok,
                };
                const files = state.writes.length === 0 ? undefined : state.writes.map((write) => write.path);
                const outcome: RunScriptOutput = result.ok
                    ? {
                          ok: true,
                          output,
                          value: result.value === undefined ? undefined : plainJson(result.value),
                          calls: state.calls,
                          script: script?.path,
                          files,
                      }
                    : { ok: false, output, error: `${result.error.kind}: ${result.error.message}`, calls: state.calls, script: script?.path, files };
                // Only a scratch directory folds the run into provenance, thus a script with none records no run.
                const record: RunScriptRecord = { run: scratch === undefined ? undefined : run, nested: state.nested };
                return ok(record.run === undefined && record.nested.length === 0 ? outcome : withToolCallRecord(outcome, record));
            } finally {
                await live.close();
                await sandbox.close();
            }
        },
    });
}
