/**
 * The heavy workers of the host process: a decode of untrusted file content, and the VM of a script.
 *
 * A decode of a file can need much more memory than the file holds, for example a parquet table of 16 MiB that
 * decodes to gigabytes of rows. On the main thread such a decode stops the whole process: V8 throws past its heap
 * cap, or the kernel kills the container. Each heavy task thus runs in a worker thread with its own V8 heap limit.
 * A task past its limit ends only its worker, and its caller gets `out_of_memory`.
 *
 * The memory of a container belongs to the process, thus the slots are module state for the whole process, the
 * same as the per-host budgets of `host-concurrency.ts`. A task that finds each slot held waits for one. The host gives
 * the memory of its workers at boot ({@link configureHostWorkers}), and the slots fit in it. A host sizes its own heap
 * cap beside that memory.
 *
 * Each worker starts from the one harness worker entry, `tools/script/codemode-worker.js`, which selects its task
 * from its worker data. A host that bundles the harness already embeds that entry for `run_script`, and
 * `assembleCoreRuntime` gives its path here. Bun accepts `resourceLimits` and does not enforce it, thus under Bun
 * a worker isolates the task and only the budgets of the callers limit it.
 */

import { Worker } from "node:worker_threads";

import { err, ok, ResultAsync, type Result } from "neverthrow";
import { z } from "zod";

import type { HostTask, HostTaskAnswer } from "../workspace/decode-tasks.js";
import { errorMessageOf } from "./thrown.js";

/** The V8 old-generation limit of each decode worker. */
export const DECODE_WORKER_HEAP_MIB = 384;

/**
 * The V8 old-generation limit of each script worker, and the memory of its VM. The worker holds the JSON of each
 * nested result and the printed output. The VM is wasm memory outside V8.
 */
export const SCRIPT_WORKER_HEAP_MIB = 128;
export const SCRIPT_VM_MEMORY_MIB = 256;

/** The young generation of each heavy worker. Without a value V8 sizes it from the memory of the machine. */
const WORKER_YOUNG_GENERATION_MIB = 16;

/** The most memory that one slot holds: a decode worker, or a script worker with its VM. */
export const DECODE_SLOT_MIB = DECODE_WORKER_HEAP_MIB + WORKER_YOUNG_GENERATION_MIB;
export const SCRIPT_SLOT_MIB = SCRIPT_WORKER_HEAP_MIB + WORKER_YOUNG_GENERATION_MIB + SCRIPT_VM_MEMORY_MIB;

/** The worker memory of a host that gives none: two decode slots and three script slots. */
export const DEFAULT_HOST_WORKER_MEMORY_MIB = 2 * DECODE_SLOT_MIB + 3 * SCRIPT_SLOT_MIB;

/** The slots that a worker memory gives, and the memory that the slots hold at most. */
export type HostWorkerBudget = { readonly decodeSlots: number; readonly scriptSlots: number; readonly memoryMib: number };

/**
 * The slots that fit in `memoryMib`. Two fifths of the slots decode, because a decode is short and a script holds its
 * slot while it waits on its lookups. Each kind gets at least one slot, thus a memory under the two smallest slots
 * still runs one decode and one script, and `memoryMib` of the budget is then more than the host gave.
 */
export function hostWorkerBudget(memoryMib: number): HostWorkerBudget {
    const total = Math.max(2, Math.floor(memoryMib / Math.max(DECODE_SLOT_MIB, SCRIPT_SLOT_MIB)));
    const decodeSlots = Math.max(1, Math.min(total - 1, Math.round(total * 0.4)));
    const scriptSlots = total - decodeSlots;
    return { decodeSlots, scriptSlots, memoryMib: decodeSlots * DECODE_SLOT_MIB + scriptSlots * SCRIPT_SLOT_MIB };
}

/** Why a heavy task gave no answer. */
export type HostTaskFailure = { readonly kind: "out_of_memory" } | { readonly kind: "crashed"; readonly detail: string } | { readonly kind: "aborted" };

/** The worker data that marks a harness task, beside the worker data of the script VM. */
export type HostTaskData = { readonly harnessTask: HostTask };

/** The message of a worker that ran a harness task of the kind `T`. */
export type HostTaskReply<T extends HostTask = HostTask> =
    | { readonly ok: true; readonly answer: HostTaskAnswer<T> }
    | { readonly ok: false; readonly detail: string };

let entryOverride: string | URL | undefined;

/**
 * Size the heavy workers of the process from the worker memory of the host, and start each worker from `entry`, the
 * embedded entry of a bundled host. An absent value keeps the default. The composition root calls it one time at
 * boot, before any work, and it gives the budget that it set.
 */
export function configureHostWorkers(config: { readonly memoryMib?: number; readonly entry?: string | URL }): HostWorkerBudget {
    entryOverride = config.entry;
    const budget = hostWorkerBudget(config.memoryMib ?? DEFAULT_HOST_WORKER_MEMORY_MIB);
    decodeSlots.width = budget.decodeSlots;
    scriptSlots.width = budget.scriptSlots;
    return budget;
}

/** The entry of each heavy worker. A source run (tests, tsx) names the `.ts` file, and the published package the `.js` file. */
export function hostWorkerEntry(): string | URL {
    if (entryOverride !== undefined) return entryOverride;
    return new URL(import.meta.url.endsWith(".ts") ? "../tools/script/codemode-worker.ts" : "../tools/script/codemode-worker.js", import.meta.url);
}

/** The V8 limits of a heavy worker with the old-generation limit `heapMib`. */
export function workerLimits(heapMib: number): { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number } {
    return { maxOldGenerationSizeMb: heapMib, maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_MIB };
}

type Slots = { width: number; inUse: number; readonly waiting: Array<() => void> };

const defaultBudget = hostWorkerBudget(DEFAULT_HOST_WORKER_MEMORY_MIB);
const decodeSlots: Slots = { width: defaultBudget.decodeSlots, inUse: 0, waiting: [] };
const scriptSlots: Slots = { width: defaultBudget.scriptSlots, inUse: 0, waiting: [] };

/**
 * Wait for a slot, and give the function that frees it, or `undefined` when `signal` aborts first. An aborted wait
 * leaves the queue. The function frees the slot one time only.
 */
async function acquire(slots: Slots, signal?: AbortSignal): Promise<(() => void) | undefined> {
    if (signal?.aborted === true) return undefined;
    if (slots.inUse >= slots.width) {
        const granted = await new Promise<boolean>((resolve) => {
            const grant = (): void => {
                signal?.removeEventListener("abort", leave);
                resolve(true);
            };
            const leave = (): void => {
                const at = slots.waiting.indexOf(grant);
                if (at !== -1) slots.waiting.splice(at, 1);
                resolve(false);
            };
            slots.waiting.push(grant);
            signal?.addEventListener("abort", leave, { once: true });
        });
        if (!granted) return undefined;
    } else {
        slots.inUse += 1;
    }
    let freed = false;
    return () => {
        if (freed) return;
        freed = true;
        // A waiting task takes the slot directly, thus `inUse` stays the same and no new task can pass it.
        const next = slots.waiting.shift();
        if (next === undefined) slots.inUse -= 1;
        else next();
    };
}

/** Wait for a script slot, and give the function that frees it. The VM launcher of `run_script` holds it until its worker exits. */
export async function acquireScriptSlot(): Promise<() => void> {
    const free = await acquire(scriptSlots);
    // A wait with no signal ends only with a grant.
    if (free === undefined) throw new Error("a script slot wait with no signal ended with no slot");
    return free;
}

/** The slots that are held and the tasks that wait, for a test. */
export function hostWorkerSlotsForTest(): {
    decode: { width: number; inUse: number; waiting: number };
    script: { width: number; inUse: number; waiting: number };
} {
    return {
        decode: { width: decodeSlots.width, inUse: decodeSlots.inUse, waiting: decodeSlots.waiting.length },
        script: { width: scriptSlots.width, inUse: scriptSlots.inUse, waiting: scriptSlots.waiting.length },
    };
}

/** The error of a worker that passed its heap limit. Node names it with this code. */
const WorkerOutOfMemorySchema = z.looseObject({ code: z.literal("ERR_WORKER_OUT_OF_MEMORY") });

/** Whether a worker error is the end of its heap. */
function isOutOfMemory(error: unknown): boolean {
    return WorkerOutOfMemorySchema.safeParse(error).success;
}

/** The options of one task: the buffers that move to the worker, the cancel, and the V8 old-generation limit. */
export type HostTaskOptions = { readonly transfer?: readonly ArrayBuffer[]; readonly signal?: AbortSignal; readonly heapMib?: number };

/** Run one task in a decode slot that the caller holds. */
export type DecodeRun = <T extends HostTask>(task: T, options?: HostTaskOptions) => ResultAsync<HostTaskAnswer<T>, HostTaskFailure>;

type Outcome<T extends HostTask> = { ok: true; answer: HostTaskAnswer<T> } | { ok: false; failure: HostTaskFailure };

/**
 * Run one task in a fresh decode worker with the V8 limit `heapMib`. `transfer` moves buffers to the worker with no
 * copy, thus the caller must not read them after the call. The answer is the value that the task gave. A task that
 * throws is `crashed`, a worker past its heap is `out_of_memory`, and `signal` ends the worker as `aborted`, also a
 * signal that aborted before the start.
 */
function runInWorker<T extends HostTask>(task: T, options: HostTaskOptions): Promise<Outcome<T>> {
    return new Promise((resolve) => {
        if (options.signal?.aborted === true) {
            resolve({ ok: false, failure: { kind: "aborted" } });
            return;
        }
        const data: HostTaskData = { harnessTask: task };
        let worker: Worker;
        try {
            worker = new Worker(hostWorkerEntry(), {
                workerData: data,
                transferList: [...(options.transfer ?? [])],
                resourceLimits: workerLimits(options.heapMib ?? DECODE_WORKER_HEAP_MIB),
            });
        } catch (cause) {
            resolve({ ok: false, failure: { kind: "crashed", detail: `the worker did not start: ${errorMessageOf(cause) ?? "an unknown fault"}` } });
            return;
        }
        let settled = false;
        const settle = (outcome: Outcome<T>): void => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener("abort", onAbort);
            void worker.terminate();
            resolve(outcome);
        };
        const onAbort = (): void => settle({ ok: false, failure: { kind: "aborted" } });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        // The harness entry posts one reply, and `runDecodeTask` made its answer from this task, thus the reply
        // has the type of the answer of `T`.
        worker.on("message", (message: HostTaskReply<T>) => {
            if (message.ok) settle({ ok: true, answer: message.answer });
            else settle({ ok: false, failure: { kind: "crashed", detail: message.detail } });
        });
        worker.on("error", (error) => {
            settle({ ok: false, failure: isOutOfMemory(error) ? { kind: "out_of_memory" } : { kind: "crashed", detail: String(error) } });
        });
        worker.on("exit", (code) => settle({ ok: false, failure: { kind: "crashed", detail: `the worker exited with code ${String(code)} and no answer` } }));
    });
}

/**
 * Hold a decode slot for `body`, and free it when `body` ends. A caller reads the bytes of a file inside `body`, thus
 * a read that waits for a slot holds no bytes, and the process holds the bytes of at most the decode slots. An abort
 * of `signal` while the caller waits gives `aborted`, and `body` does not run.
 */
export async function withDecodeSlot<R>(
    signal: AbortSignal | undefined,
    body: (run: DecodeRun) => Promise<R>,
): Promise<Result<R, { readonly kind: "aborted" }>> {
    const free = await acquire(decodeSlots, signal);
    if (free === undefined) return err({ kind: "aborted" });
    const run: DecodeRun = (task, options = {}) =>
        new ResultAsync(
            runInWorker(task, { ...options, signal: options.signal ?? signal }).then((outcome) => (outcome.ok ? ok(outcome.answer) : err(outcome.failure))),
        );
    try {
        return ok(await body(run));
    } finally {
        free();
    }
}

/** Run one task in a decode slot, after the slot is free. See {@link withDecodeSlot}. */
export function runHostTask<T extends HostTask>(task: T, options: HostTaskOptions = {}): ResultAsync<HostTaskAnswer<T>, HostTaskFailure> {
    return new ResultAsync(withDecodeSlot(options.signal, (run) => Promise.resolve(run(task, options)))).andThen((ran) => ran);
}

/**
 * The buffer of `bytes` to transfer to a worker, and a view of it. A view that covers its whole buffer transfers
 * that buffer. A view of part of a buffer (a pooled `Buffer`) copies its bytes into a new one, because a transfer
 * would detach the bytes of other views.
 */
export function transferable(bytes: Uint8Array): ArrayBuffer {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
}
