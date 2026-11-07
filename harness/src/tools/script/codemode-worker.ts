/**
 * The entry of each heavy worker of the harness: the VM of `run_script`, and a decode task (`lib/host-workers.ts`).
 * An embedder that bundles the harness, for example a Bun single-file binary, adds this module as an entry of its
 * build, and gives its embedded path as `ScriptRuntime.workerUrl`.
 *
 * A decode task carries `harnessTask` in its worker data. Each other worker is a script VM, and the pi-codemode worker
 * starts when its module loads, thus the entry loads it only for a VM.
 */

import { parentPort, workerData } from "node:worker_threads";

import { z } from "zod";

import type { HostTaskReply } from "../../lib/host-workers.js";
import { errorMessageOf, errorNameOf } from "../../lib/thrown.js";
import type { HostTask } from "../../workspace/decode-tasks.js";

/**
 * The worker data of a decode task. `runHostTask` of the same process built the task, thus the entry trusts its
 * shape and only reads its mark.
 */
const HostTaskDataSchema = z.object({ harnessTask: z.custom<HostTask>((task) => task !== undefined) });

const hostTask = HostTaskDataSchema.safeParse(workerData);

if (hostTask.success) {
    const { runDecodeTask } = await import("../../workspace/decode-tasks.js");
    let reply: HostTaskReply;
    try {
        reply = { ok: true, answer: await runDecodeTask(hostTask.data.harnessTask) };
    } catch (cause) {
        reply = { ok: false, detail: `${errorNameOf(cause) ?? "Error"}: ${errorMessageOf(cause) ?? "an unknown fault"}` };
    }
    parentPort?.postMessage(reply);
} else {
    await import("@earendil-works/pi-codemode/worker");
}
