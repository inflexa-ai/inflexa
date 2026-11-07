/**
 * The heavy workers of the host process: a decode of untrusted file content, and the VM of a script.
 *
 * A decode of a file can need much more memory than the file holds, for example a parquet table of 16 MiB that
 * decodes to gigabytes of rows. On the main thread such a decode stops the whole process: V8 throws past its heap
 * cap, or the kernel kills the container. Each heavy task thus runs in a worker thread with its own V8 heap limit.
 * A task past its limit ends only its worker, and its caller gets `out_of_memory`.
 *
 * The memory of a container belongs to the process, thus the slots are module state for the whole process, the
 * same as the per-host budgets of `host-concurrency.ts`. A task that finds each slot held waits for one. The sum of
 * the limits of all slots is {@link HOST_WORKER_MEMORY_MIB}: a host sizes its own heap cap beside it.
 *
 * Each worker starts from the one harness worker entry, `tools/script/codemode-worker.js`, which selects its task
 * from its worker data. A host that bundles the harness already embeds that entry for `run_script`, and
 * `assembleCoreRuntime` gives its path here. Bun accepts `resourceLimits` and does not enforce it, thus under Bun
 * a worker isolates the task and only the budgets of the callers limit it.
 */

import { Worker } from "node:worker_threads";

import { err, errAsync, ok, ResultAsync } from "neverthrow";
import { z } from "zod";

import type { HostTask, HostTaskAnswer } from "../workspace/decode-tasks.js";
import { errorMessageOf } from "./thrown.js";

/** The decode workers that run at the same time, and the V8 old-generation limit of each one. */
export const DECODE_WORKER_SLOTS = 2;
export const DECODE_WORKER_HEAP_MIB = 384;

/**
 * The script workers that run at the same time, the V8 old-generation limit of each one, and the memory of its VM.
 * The worker holds the JSON of each nested result and the printed output. The VM is wasm memory outside V8.
 */
export const SCRIPT_WORKER_SLOTS = 3;
export const SCRIPT_WORKER_HEAP_MIB = 128;
export const SCRIPT_VM_MEMORY_MIB = 256;

/** The young generation of each heavy worker. Without a value V8 sizes it from the memory of the machine. */
const WORKER_YOUNG_GENERATION_MIB = 16;

/** The most memory that the heavy workers of the process hold at the same time. */
export const HOST_WORKER_MEMORY_MIB =
    DECODE_WORKER_SLOTS * (DECODE_WORKER_HEAP_MIB + WORKER_YOUNG_GENERATION_MIB) +
    SCRIPT_WORKER_SLOTS * (SCRIPT_WORKER_HEAP_MIB + WORKER_YOUNG_GENERATION_MIB + SCRIPT_VM_MEMORY_MIB);

/** Why a heavy task gave no answer. */
export type HostTaskFailure = { readonly kind: "out_of_memory" } | { readonly kind: "crashed"; readonly detail: string } | { readonly kind: "aborted" };

/** The worker data that marks a harness task, beside the worker data of the script VM. */
export type HostTaskData = { readonly harnessTask: HostTask };

/** The message of a worker that ran a harness task of the kind `T`. */
export type HostTaskReply<T extends HostTask = HostTask> =
    | { readonly ok: true; readonly answer: HostTaskAnswer<T> }
    | { readonly ok: false; readonly detail: string };

let entryOverride: string | URL | undefined;

/** Start each heavy worker from `url`, the embedded entry of a bundled host. `undefined` restores the entry beside this module. */
export function setHostWorkerEntry(url: string | URL | undefined): void {
    entryOverride = url;
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

type Slots = { readonly width: number; inUse: number; readonly waiting: Array<() => void> };

const decodeSlots: Slots = { width: DECODE_WORKER_SLOTS, inUse: 0, waiting: [] };
const scriptSlots: Slots = { width: SCRIPT_WORKER_SLOTS, inUse: 0, waiting: [] };

/** Wait for a slot, and give the function that frees it. The function frees the slot one time only. */
async function acquire(slots: Slots): Promise<() => void> {
    if (slots.inUse >= slots.width) await new Promise<void>((resolve) => slots.waiting.push(resolve));
    else slots.inUse += 1;
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
export function acquireScriptSlot(): Promise<() => void> {
    return acquire(scriptSlots);
}

/** The slots that are held and the tasks that wait, for a test. */
export function hostWorkerSlotsForTest(): { decode: { inUse: number; waiting: number }; script: { inUse: number; waiting: number } } {
    return {
        decode: { inUse: decodeSlots.inUse, waiting: decodeSlots.waiting.length },
        script: { inUse: scriptSlots.inUse, waiting: scriptSlots.waiting.length },
    };
}

/** The error of a worker that passed its heap limit. Node names it with this code. */
const WorkerOutOfMemorySchema = z.looseObject({ code: z.literal("ERR_WORKER_OUT_OF_MEMORY") });

/** Whether a worker error is the end of its heap. */
function isOutOfMemory(error: unknown): boolean {
    return WorkerOutOfMemorySchema.safeParse(error).success;
}

/**
 * Run one task in a fresh decode worker with the V8 limit `heapMib`, after a decode slot is free. `transfer` moves
 * buffers to the worker with no copy, thus the caller must not read them after the call. The answer is the value
 * that the task gave. A task that throws is `crashed`, a worker past its heap is `out_of_memory`, and `signal`
 * ends the worker as `aborted`.
 */
export function runHostTask<T extends HostTask>(
    task: T,
    options: { readonly transfer?: readonly ArrayBuffer[]; readonly signal?: AbortSignal; readonly heapMib?: number } = {},
): ResultAsync<HostTaskAnswer<T>, HostTaskFailure> {
    if (options.signal?.aborted === true) return errAsync({ kind: "aborted" });
    const run = async (): Promise<{ ok: true; answer: HostTaskAnswer<T> } | { ok: false; failure: HostTaskFailure }> => {
        const free = await acquire(decodeSlots);
        try {
            return await new Promise((resolve) => {
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
                const settle = (outcome: { ok: true; answer: HostTaskAnswer<T> } | { ok: false; failure: HostTaskFailure }): void => {
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
                worker.on("exit", (code) =>
                    settle({ ok: false, failure: { kind: "crashed", detail: `the worker exited with code ${String(code)} and no answer` } }),
                );
            });
        } finally {
            free();
        }
    };
    return new ResultAsync(run().then((outcome) => (outcome.ok ? ok(outcome.answer) : err(outcome.failure))));
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
