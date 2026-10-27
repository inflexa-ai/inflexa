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

import { setTimeout as sleep } from "node:timers/promises";

import { DBOS } from "@dbos-inc/dbos-sdk";
import { functionIDGetIncrement, getCurrentContextStore } from "@dbos-inc/dbos-sdk/internal/context";
import { readDurableStream, toolWriter, writeDurableStream, type DurableStreamSource } from "@dbos-inc/vercel-ai";
import type { UIMessageChunk, UIMessageStreamWriter } from "ai";
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

/** The source of a frame that comes before the first frame of the harness. A turn writes no such frame. */
const UNKNOWN_SOURCE: EventSource = { agentId: "", callPath: [] };

const HarnessFrameChunkSchema = z.object({
    type: z.literal(HARNESS_FRAME_CHUNK),
    data: z.looseObject({ type: z.string() }),
});

/** The chunk that carries one frame of the harness in the stream of a turn. A transient chunk is live only. */
export function chunkOfFrame(frame: ChatFrame, transient = false): UIMessageChunk {
    return transient ? { type: HARNESS_FRAME_CHUNK, data: frame, transient: true } : { type: HARNESS_FRAME_CHUNK, data: frame };
}

/**
 * Whether a frame from a tool step shows progress only. The library gives such a frame live, and a replay of the
 * step does not give it again. Each other frame of a tool step is checkpointed with the step, and the display of a
 * round that a recovery stores keeps it: the end of each call, and each part of the root agent.
 */
function isProgressFrame(frame: ChatFrame): boolean {
    if (!isRootFrame(frame) || frame.type === "tool-started" || frame.type === "iteration") return true;
    return isKnownPartType(frame.type) && PART_REGISTRY[frame.type].transient;
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
 * Run each body write of one workflow after the body write before it ends.
 *
 * DBOS gives a stream write its offset inside the insert, thus two writes in flight take the same offset, and the
 * write that loses sleeps 100 ms before it tries again. A body write must still take its function id at the call,
 * because a replay finds each checkpoint by the order of the calls. Thus the call reserves its id now, and the
 * chained write takes the reserved id from the context of the workflow when it starts.
 */
function chainBodyWrites(): (start: () => Promise<void>) => Promise<void> {
    let tail: Promise<void> = Promise.resolve();
    return (start) => {
        const ctx = getCurrentContextStore();
        if (ctx === undefined || !DBOS.isInWorkflow() || DBOS.isInStep()) return start();
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
        const write = tail.then(run, run);
        tail = write.then(
            () => undefined,
            () => undefined,
        );
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
    const chained = chainBodyWrites();
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
        // A tool step gives its frames to the library, which checkpoints each one that is not progress.
        if (DBOS.isInStep()) {
            toolWriter().write(chunkOfFrame(frame, isProgressFrame(frame)));
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
            return [{ type: "finish", source: rootSource }];
        default: {
            const frame = harnessFrameOf(chunk);
            return frame === undefined ? [] : [frame];
        }
    }
}

export type ReadChatTurnOptions = {
    /**
     * The source of the root agent of the turn, which the text of each model call takes. Absent: the source of the
     * first frame of the harness, which the turn writes before its first model call.
     */
    readonly rootSource?: EventSource;
    /** A `DBOSClient` for a process that did not launch DBOS. Absent: the `DBOS` of this process. */
    readonly client?: DurableStreamSource;
};

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
async function* childChunks(workflowID: string, client: DurableStreamSource | undefined): AsyncGenerator<UIMessageChunk> {
    const source = client ?? DBOS;
    const deadline = Date.now() + CHILD_START_WAIT_MS;
    while ((await source.retrieveWorkflow(workflowID).getStatus()) === null) {
        if (Date.now() > deadline) return;
        await sleep(CHILD_START_POLL_MS);
    }
    yield* readDurableStream({ workflowID, key: CHAT_STREAM_KEY, client, sendReasoning: false });
}

/**
 * Read the frames of a turn from its start, live, until the turn ends. A second read gives the same frames.
 *
 * The read merges the stream of each sub-agent child that the turn names, in the order of arrival. A child stream
 * gives only the frames of the harness: the child ends before its caller continues, and the result of its tool call
 * tells its outcome. The end frame of the turn comes last.
 */
export async function* readChatTurn(turnId: string, options: ReadChatTurnOptions): AsyncGenerator<ChatFrame> {
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
    const root = open(readDurableStream({ workflowID: turnId, key: CHAT_STREAM_KEY, client: options.client, sendReasoning: false }));
    let rootSource = options.rootSource;
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
                open(childChunks(child.data.workflowId, options.client));
                continue;
            }
            if (reader !== root) {
                if (frame !== undefined) yield frame;
                continue;
            }
            rootSource ??= frame?.source;
            for (const rootFrame of framesOfChunk(next.value, rootSource ?? UNKNOWN_SOURCE)) {
                if (rootFrame.type === "finish" || rootFrame.type === "error") ends.push(rootFrame);
                else yield rootFrame;
            }
        }
        yield* ends;
    } finally {
        await Promise.all(readers.map(async (reader) => await reader.return?.()));
    }
}
