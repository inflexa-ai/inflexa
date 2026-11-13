/**
 * The durable stream of a chat turn, and of each sub-agent of the turn.
 *
 * The turn writes to the stream of its workflow with the writer of
 * `@dbos-inc/vercel-ai`: each model call writes its text from inside its step,
 * and the harness writes each of its own frames as one `data-harness-frame`
 * chunk. The reader converts the chunks to the `ChatFrame`s that a host gives
 * its client. A model record also holds the input of each tool call, and the
 * converter drops it, thus a client gets the frames of an in-process turn.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { functionIDGetIncrement, getCurrentContextStore } from "@dbos-inc/dbos-sdk/internal/context";
import { readDurableStream, toolWriter, writeDurableStream, type DurableStreamSource } from "@dbos-inc/vercel-ai";
import type { LanguageModelMiddleware, UIMessageChunk, UIMessageStreamWriter } from "ai";
import { z } from "zod";

import type { ChatFrame, EventSource } from "../contracts/chat-events.js";
import { checkChatPart, isRootFrame, toChatFrame } from "../contracts/chat-frame.js";
import { isKnownPartType, PART_REGISTRY } from "../contracts/part-registry.js";
import { ChatEventSchema } from "../contracts/schemas/chat-events.js";
import type { EmitFn } from "./types.js";

/** The key of the durable stream of a chat turn. */
export const CHAT_STREAM_KEY = "chat";

/** The data part that names the child workflow of a sub-agent call in the stream of its caller. */
export const SUB_AGENT_STREAM_PART = "data-subagent-stream";

const SubAgentStreamFrameSchema = z.object({ type: z.literal(SUB_AGENT_STREAM_PART), workflowId: z.string() });

const HARNESS_FRAME_CHUNK = "data-harness-frame";

const MODEL_EXECUTION_CHUNK = "data-model-execution";

const ModelExecutionChunkSchema = z.object({
    type: z.literal(MODEL_EXECUTION_CHUNK),
    data: z.object({ step: z.number(), execution: z.string() }),
});

/** The source of a frame that comes before the first frame of the harness. A turn writes no such frame. */
const UNKNOWN_SOURCE: EventSource = { agentId: "", callPath: [] };

const HarnessFrameChunkSchema = z.object({
    type: z.literal(HARNESS_FRAME_CHUNK),
    data: z.looseObject({ type: z.string() }),
});

/**
 * The chunk that carries one frame of the harness in the stream of a turn. A transient chunk is in the stream, and
 * a reader gets it. A replay of the step does not write it again, and the stored transcript does not hold it.
 */
export function chunkOfFrame(frame: ChatFrame, transient = false): UIMessageChunk {
    return transient ? { type: HARNESS_FRAME_CHUNK, data: frame, transient: true } : { type: HARNESS_FRAME_CHUNK, data: frame };
}

/**
 * Whether a frame from a step shows progress only. Such a frame goes to the stream at once, and a replay of the step
 * does not write it again. Each other frame of a tool step is checkpointed with the step, and the display of a
 * round that a recovery stores keeps it: the end of each call, and each part of the root agent.
 */
function isProgressFrame(frame: ChatFrame): boolean {
    if (!isRootFrame(frame) || frame.type === "tool-started" || frame.type === "iteration") return true;
    return isKnownPartType(frame.type) && PART_REGISTRY[frame.type].transient;
}

/**
 * A model middleware that writes one marker to the stream before each execution of a model step, and that puts the
 * execution in the id of each text part of the step. A reader tells a new execution of a step from the one before it by
 * the marker, also when the new execution writes no text, and it drops a text that carries another execution than the
 * last marker. A checkpointed step does not run its body, thus a replay writes no marker. Outside a step the
 * middleware writes nothing.
 */
export function modelExecutionMarker(key: string): LanguageModelMiddleware {
    return {
        specificationVersion: "v4",
        wrapStream: async ({ doStream }) => {
            const step = DBOS.isInStep() ? DBOS.stepID : undefined;
            if (step === undefined) return await doStream();
            const execution = randomUUID();
            // The write lands before each record of the library writer of this execution, because the request starts after it.
            await writeDurableStream(key, [{ type: MODEL_EXECUTION_CHUNK, data: { step, execution }, transient: true }]);
            const result = await doStream();
            return { ...result, stream: result.stream.pipeThrough(tagTextWithExecution(execution)) };
        },
    };
}

/**
 * The library writer composes the id of a text chunk as `${attempt}:${part id}`, and the part id of a text is only
 * unique within one model call. The execution goes in front of the part id, thus a read takes the execution of a text
 * from its chunk id. The AI SDK matches a text delta to its start by this id, and the three types change in the same way.
 */
function tagTextWithExecution(execution: string): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
    return new TransformStream({
        transform(part, controller) {
            const tagged = part.type === "text-start" || part.type === "text-delta" || part.type === "text-end";
            controller.enqueue(tagged ? { ...part, id: `${execution}:${part.id}` } : part);
        },
    });
}

/** What the body of a turn workflow writes to its stream, and what each of its tool steps writes. */
export type TurnStreamWriter = {
    /** The emit sink of the loop of the turn. */
    readonly emit: EmitFn;
    /** The writer that the tool steps of the turn give their chunks to, through the library. */
    readonly toolWriter: UIMessageStreamWriter;
    /** Write one frame from the body of the workflow. */
    write(frame: ChatFrame): Promise<void>;
    /** Wait for each write in flight. A failed write fails the call. */
    settle(): Promise<void>;
};

/**
 * Run each body write of one workflow after the body write before it ends, and each step write after the step write
 * before it ends.
 *
 * DBOS gives a stream write its offset inside the insert, thus two writes in flight take the same offset, and the
 * write that loses sleeps 100 ms before it tries again. A body write must still take its function id at the call,
 * because a replay finds each checkpoint by the order of the calls. Thus the call reserves its id now, and the
 * chained write takes the reserved id from the context of the workflow when it starts. A step write takes no
 * function id, thus its chain reserves none.
 */
function chainWrites(): (start: () => Promise<void>) => Promise<void> {
    let bodyTail: Promise<void> = Promise.resolve();
    let stepTail: Promise<void> = Promise.resolve();
    const ended = (write: Promise<void>): Promise<void> =>
        write.then(
            () => undefined,
            () => undefined,
        );
    return (start) => {
        if (DBOS.isInStep()) {
            const write = stepTail.then(start, start);
            stepTail = ended(write);
            return write;
        }
        const ctx = getCurrentContextStore();
        if (ctx === undefined || !DBOS.isInWorkflow()) return start();
        const reserved = functionIDGetIncrement();
        const run = (): Promise<void> => {
            // A continuation keeps the async context of its call, thus DBOS reads the id from this same context.
            if (getCurrentContextStore() !== ctx) throw new Error("A chained stream write lost the context of its workflow.");
            const next = ctx.curWFFunctionId;
            ctx.curWFFunctionId = reserved;
            try {
                // DBOS takes the function id before its first await, thus the swap ends before any other call can read it.
                return start();
            } finally {
                ctx.curWFFunctionId = next;
            }
        };
        const write = bodyTail.then(run, run);
        bodyTail = ended(write);
        return write;
    };
}

/**
 * The writer of the stream of a turn workflow. `observe` gets each frame of the turn that goes to the stream: the
 * frames of the body, and the frames of each tool step, the frames that a replay of a step gives again included.
 *
 * From the body a write is checkpointed, thus a replay writes nothing again. From a step a write is at-least-once,
 * and a fold of the frames by the id of a tool call or a part makes a second copy harmless.
 */
export function createTurnStreamWriter(rootSource: EventSource, observe: (frame: ChatFrame) => void): TurnStreamWriter {
    const pending: Promise<void>[] = [];
    const chained = chainWrites();
    const track = (write: Promise<void>): void => {
        // Observed now, thus a failure before the settle is not an unhandled rejection. The settle still sees it.
        write.catch(() => undefined);
        pending.push(write);
    };

    const writer: UIMessageStreamWriter = {
        write(chunk) {
            const frame = harnessFrameOf(chunk);
            if (frame !== undefined) observe(frame);
            track(chained(() => writeDurableStream(CHAT_STREAM_KEY, [chunk])));
        },
        merge(stream) {
            track(
                (async () => {
                    for await (const chunk of stream) writer.write(chunk);
                })(),
            );
        },
        onError: undefined,
    };

    const write = async (frame: ChatFrame): Promise<void> => {
        observe(frame);
        await chained(() => writeDurableStream(CHAT_STREAM_KEY, [chunkOfFrame(frame)]));
    };

    const emit: EmitFn = async (event) => {
        const frame = toChatFrame(event, rootSource);
        if (frame === null) return;
        if (DBOS.isInStep()) {
            const liveOnly = "transient" in event && event.transient === true;
            const transient = liveOnly || isProgressFrame(frame);
            // A model step has no library writer, and a transient chunk is not checkpointed with its step. Thus the
            // chunk goes straight to the stream. The library checkpoints each other frame with its tool step.
            if (transient) writer.write(chunkOfFrame(frame, true));
            else toolWriter().write(chunkOfFrame(frame));
            return;
        }
        await write(frame);
    };

    return {
        emit,
        toolWriter: writer,
        write,
        async settle() {
            while (pending.length > 0) await Promise.all(pending.splice(0));
        },
    };
}

/** The frame that one harness chunk carries, checked as a frame from outside the process. */
function harnessFrameOf(chunk: UIMessageChunk): ChatFrame | undefined {
    const carried = HarnessFrameChunkSchema.safeParse(chunk);
    if (!carried.success) return undefined;
    if (carried.data.data.type.startsWith("data-")) {
        const part = checkChatPart(carried.data.data);
        return part.ok ? part.frame : undefined;
    }
    const event = ChatEventSchema.safeParse(carried.data.data);
    return event.success ? event.data : undefined;
}

/**
 * The frames of one chunk of the stream. The text of a model call is the text of the root agent, because a
 * sub-agent writes to the stream of its own workflow. The end chunks of the library carry no fact of the turn,
 * except the error and the abort of a workflow that ended before the turn wrote its own end.
 */
export function framesOfChunk(chunk: UIMessageChunk, rootSource: EventSource): ChatFrame[] {
    switch (chunk.type) {
        case "text-delta":
            return chunk.delta.length === 0 ? [] : [{ type: "text-delta", text: chunk.delta, source: rootSource }];
        case "error":
            return [{ type: "error", message: chunk.errorText, source: rootSource }];
        case "abort":
            return [{ type: "finish", source: rootSource, finishReason: "aborted" }];
        default: {
            const frame = harnessFrameOf(chunk);
            return frame === undefined ? [] : [frame];
        }
    }
}

/** What a read needs from DBOS: the `DBOS` class in a launched process, or a `DBOSClient` anywhere else. */
export type ChatStreamSource = {
    readStream<T>(workflowID: string, key: string, options?: { offset?: number; timeoutSeconds?: number }): AsyncGenerator<T, void, unknown>;
    readStreamOffset<T>(workflowID: string, key: string, offset: number, options?: { timeoutSeconds?: number }): Promise<T>;
    retrieveWorkflow(workflowID: string): { getStatus(): Promise<{ status: string; error?: unknown } | null> };
};

export type ReadChatTurnOptions = {
    /**
     * The source of the root agent of the turn, which the text of each model call takes. Absent: the source of the
     * first frame of the harness, which the turn writes before its first model call.
     */
    readonly rootSource?: EventSource;
    /** A `DBOSClient` for a process that did not launch DBOS. Absent: the `DBOS` of this process. */
    readonly client?: ChatStreamSource;
};

/**
 * How long a live read of the stream waits for a value before it asks again. DBOS looks at the deadline of a wait
 * only after a query, thus a read in progress ends one poll after its window, and the window stays below the 5 seconds
 * that a stopped read can take.
 */
const READ_WINDOW_SECONDS = 4;

/**
 * The source that a read gives to the library reader. A live read waits one window for each value and then asks
 * again from the next offset, until the signal aborts. After the abort no read of the stream starts, and the read in
 * progress ends within one window.
 */
function stoppableSource(inner: ChatStreamSource, signal: AbortSignal): DurableStreamSource {
    async function* readStream<T>(workflowID: string, key: string, options?: { offset?: number }): AsyncGenerator<T, void, unknown> {
        let offset = options?.offset ?? 0;
        while (!signal.aborted) {
            try {
                for await (const value of inner.readStream<T>(workflowID, key, { offset, timeoutSeconds: READ_WINDOW_SECONDS })) {
                    offset += 1;
                    yield value;
                }
                return;
            } catch (error) {
                if (!DBOSErrors.isStreamTimeoutError(error)) throw error;
            }
        }
    }
    return {
        readStream,
        // The library keeps one attempt of each model step from the stored records that it reads here, and it skips the
        // other attempts. The reader tells the executions of a step apart by their markers, and a skipped record can be
        // the one that holds the new reply. A timeout at each offset gives the library no stored record, thus it reads
        // each record live.
        readStreamOffset: (workflowID, key) => Promise.reject(new DBOSErrors.DBOSStreamTimeoutError(workflowID, key, 0)),
        retrieveWorkflow: (workflowID) => inner.retrieveWorkflow(workflowID),
    };
}

/**
 * The executions of the model steps that the root stream shows. The reader gives each text chunk to `admit`, and it
 * gives each marker to `mark`.
 */
type ExecutionLedger = {
    /** Record a marker. Gives the length of the text that the execution before it gave, when it is of the same step. */
    mark(step: number, execution: string): number;
    /** Whether a text chunk of an execution shows. After a marker, only a text of the execution of the last marker does. */
    admit(execution: string | undefined, length: number): boolean;
};

function createExecutionLedger(): ExecutionLedger {
    let last: { readonly step: number; readonly execution: string } | undefined;
    let count = 0;
    return {
        mark(step, execution) {
            if (last?.step === step && last.execution === execution) return 0;
            const superseded = last?.step === step ? count : 0;
            last = { step, execution };
            count = 0;
            return superseded;
        },
        admit(execution, length) {
            if (last === undefined) return true;
            if (execution !== last.execution) return false;
            count += length;
            return true;
        },
    };
}

/** The id of a text chunk is `${attempt}:${execution}:${part id}`, and an attempt id and an execution id hold no colon. */
function executionOfTextChunk(id: string): string | undefined {
    const first = id.indexOf(":");
    const second = first === -1 ? -1 : id.indexOf(":", first + 1);
    return second === -1 ? undefined : id.slice(first + 1, second);
}

type ChunkReader = AsyncIterator<UIMessageChunk>;
type StreamRead = { readonly reader: ChunkReader; readonly next: IteratorResult<UIMessageChunk> };

/** How long a read waits for a child workflow that its caller named, and the interval of each look. */
const CHILD_START_WAIT_MS = 10_000;
const CHILD_START_POLL_MS = 50;

/**
 * The chunks of the stream of a sub-agent child. The caller names the child in the same tick as it starts the child,
 * thus the name can arrive before the child exists, and a read of a stream of no workflow fails. A child that never
 * starts fails the tool call of its caller, and the result of that call tells it.
 */
async function* childChunks(workflowID: string, source: DurableStreamSource, signal: AbortSignal): AsyncGenerator<UIMessageChunk> {
    const deadline = Date.now() + CHILD_START_WAIT_MS;
    while ((await source.retrieveWorkflow(workflowID).getStatus()) === null) {
        if (signal.aborted || Date.now() > deadline) return;
        await sleep(CHILD_START_POLL_MS);
    }
    if (signal.aborted) return;
    yield* readDurableStream({ workflowID, key: CHAT_STREAM_KEY, client: source, sendReasoning: false });
}

/**
 * Read the frames of a turn from its start, live, until the turn ends. A second read gives the same frames.
 *
 * The read merges the stream of each sub-agent child that the turn names, in the order of arrival. A child stream
 * gives only the frames of the harness: the child ends before its caller continues, and the result of its tool call
 * tells its outcome. The end frame of the turn comes last.
 */
export async function* readChatTurn(turnId: string, options: ReadChatTurnOptions): AsyncGenerator<ChatFrame> {
    const stop = new AbortController();
    const source = stoppableSource(options.client ?? DBOS, stop.signal);
    const readers: ChunkReader[] = [];
    const reads = new Map<ChunkReader, Promise<StreamRead>>();
    const pull = (reader: ChunkReader): void => {
        reads.set(
            reader,
            reader.next().then((next) => ({ reader, next })),
        );
    };
    const open = (chunks: AsyncIterable<UIMessageChunk>): ChunkReader => {
        const reader = chunks[Symbol.asyncIterator]();
        readers.push(reader);
        pull(reader);
        return reader;
    };
    const root = open(readDurableStream({ workflowID: turnId, key: CHAT_STREAM_KEY, client: source, sendReasoning: false }));
    let rootSource = options.rootSource;
    const executions = createExecutionLedger();
    const ends: ChatFrame[] = [];
    try {
        while (reads.size > 0) {
            const { reader, next } = await Promise.race(reads.values());
            if (next.done === true) {
                reads.delete(reader);
                continue;
            }
            pull(reader);
            const frame = harnessFrameOf(next.value);
            const child = SubAgentStreamFrameSchema.safeParse(frame);
            if (child.success) {
                open(childChunks(child.data.workflowId, source, stop.signal));
                continue;
            }
            if (reader !== root) {
                if (frame !== undefined) yield frame;
                continue;
            }
            rootSource ??= frame?.source;
            const marker = ModelExecutionChunkSchema.safeParse(next.value);
            if (marker.success) {
                const superseded = executions.mark(marker.data.data.step, marker.data.data.execution);
                if (superseded > 0) yield { type: "text-superseded", length: superseded, source: rootSource ?? UNKNOWN_SOURCE };
                continue;
            }
            if (next.value.type === "text-delta" && !executions.admit(executionOfTextChunk(next.value.id), next.value.delta.length)) continue;
            for (const rootFrame of framesOfChunk(next.value, rootSource ?? UNKNOWN_SOURCE)) {
                if (rootFrame.type === "finish" || rootFrame.type === "error") ends.push(rootFrame);
                else yield rootFrame;
            }
        }
        yield* ends;
    } finally {
        // A reader that waits for its next value closes only after that value, thus the close is not awaited. The stop
        // ends each read of the stream within one window, and the readers then close in the background.
        stop.abort();
        for (const read of reads.values()) void read.catch(() => undefined);
        for (const reader of readers) void Promise.resolve(reader.return?.()).catch(() => undefined);
    }
}
