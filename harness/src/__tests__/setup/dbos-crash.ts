/**
 * A crash in the middle of a workflow, for a test of its recovery.
 *
 * The body parks at `crashPoint`. The test cancels the workflow from outside,
 * resumes it, and releases the replay past the point. The replay returns each
 * step that completed before the point from its checkpoint, and it runs each
 * later step for the first time.
 *
 * The cancel comes from outside the workflow because DBOS 5 records no
 * self-cancel: the cancel clears the owner of the workflow, and the record of
 * the cancel then fails its owner check. A resumed body cancels itself again.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { DBOS, type WorkflowHandle } from "@dbos-inc/dbos-sdk";

const CRASH_TOPIC = "test-crash-point";

/** Park the body until the test releases it. The first run of the body is cancelled here. */
export async function crashPoint(): Promise<void> {
    await DBOS.recv<string>(CRASH_TOPIC, 60);
}

/** Whether the workflow recorded a step with this name. */
export async function stepRecorded(workflowId: string, name: string): Promise<boolean> {
    const steps = await DBOS.listWorkflowSteps(workflowId);
    return steps?.some((step) => step.name === name) ?? false;
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await sleep(25);
    }
}

/**
 * Cancel a workflow at its crash point, then resume it and release it. `ready`
 * holds when the work before the point is done: a cancel before that point
 * would cut a step whose record must survive the crash. `ended` settles when
 * the cancelled execution left the process. A crash leaves nothing behind, but
 * a cancelled execution still holds its in-memory state until it ends.
 */
export async function recoverAtCrashPoint<T>(
    workflowId: string,
    ready: () => boolean | Promise<boolean>,
    options: { readonly ended?: Promise<unknown>; readonly timeoutMs?: number } = {},
): Promise<WorkflowHandle<T>> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    await waitFor(ready, `the work of ${workflowId} before its crash point`, timeoutMs);
    await DBOS.cancelWorkflow(workflowId);
    await waitFor(async () => (await DBOS.getWorkflowStatus(workflowId))?.status === "CANCELLED", `the cancel of ${workflowId}`, timeoutMs);
    await options.ended;
    const handle = await DBOS.resumeWorkflow<T>(workflowId);
    await DBOS.send(workflowId, "release", CRASH_TOPIC);
    return handle;
}
