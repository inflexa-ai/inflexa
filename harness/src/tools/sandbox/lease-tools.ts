/**
 * `acquire_sandbox` and `release_sandbox` (sandbox-leases spec): the agent holds its sandbox through a lease.
 *
 * Each tool gives the size, and nothing else. The bound lease carries the key (the id of the workflow of the agent),
 * the session, and the spawn settings of the step, and the sandbox module owns the admission, the spawn, and the
 * teardown. `acquire_sandbox` blocks until the machine is ready, also while the lease waits in the queue.
 */

import { err, ok } from "neverthrow";
import { z } from "zod";

import type { ResourceSpec } from "../../config/resource-limits.js";
import type { BoundLease } from "../../sandbox/leases.js";
import { defineTool, type Tool } from "../define-tool.js";

export const ACQUIRE_SANDBOX_TOOL_ID = "acquire_sandbox";
export const RELEASE_SANDBOX_TOOL_ID = "release_sandbox";

const AcquireSandboxInputSchema = z.object({
    cpu: z.number().positive().describe("CPU cores of the sandbox. A fraction is permitted, and the grant can be smaller than the request."),
    memoryGb: z.number().positive().describe("Memory of the sandbox in GB. A command that uses more memory gets an out-of-memory kill."),
    gpuCount: z.number().int().nonnegative().optional().describe("GPUs of the sandbox. Omit for none."),
});

type AcquireSandboxResult = {
    readonly status: "granted";
    readonly cpu: number;
    readonly memoryGb: number;
    readonly gpuCount: number;
    readonly message: string;
};

const ReleaseSandboxInputSchema = z.object({});

type ReleaseSandboxResult = { readonly status: "released"; readonly message: string };

export function createAcquireSandboxTool(lease: BoundLease): Tool<z.infer<typeof AcquireSandboxInputSchema>, AcquireSandboxResult> {
    return defineTool({
        id: ACQUIRE_SANDBOX_TOOL_ID,
        description:
            "Get a sandbox of the given size for `execute_command`, and wait until it is ready. The call can wait for free " +
            "capacity. The result gives the granted size, which can be smaller than the request. A call with a different " +
            "size replaces your sandbox: the files of your working directory stay, and the next command runs on the new " +
            "size. Your files and your outputs live in the workspace, not in the sandbox.",
        inputSchema: AcquireSandboxInputSchema,
        describeCall: ({ cpu, memoryGb }) => `Waiting for a sandbox (${cpu} CPU, ${memoryGb} GB)`,
        execute: async ({ cpu, memoryGb, gpuCount }) => {
            const size: ResourceSpec = gpuCount === undefined || gpuCount === 0 ? { cpu, memoryGb } : { cpu, memoryGb, gpu: { count: gpuCount } };
            const outcome = await lease.acquire(size);
            switch (outcome.kind) {
                case "granted":
                    return ok({
                        status: "granted" as const,
                        cpu: outcome.size.cpu,
                        memoryGb: outcome.size.memoryGb,
                        gpuCount: outcome.size.gpu?.count ?? 0,
                        message: "The sandbox is ready.",
                    });
                case "refused":
                    return err({ error: `The host refused the sandbox: ${outcome.reason}.`, retryable: false });
                case "failed":
                    return err({ error: `The sandbox did not start: ${outcome.detail}`, retryable: true });
            }
        },
    });
}

export function createReleaseSandboxTool(lease: BoundLease): Tool<z.infer<typeof ReleaseSandboxInputSchema>, ReleaseSandboxResult> {
    return defineTool({
        id: RELEASE_SANDBOX_TOOL_ID,
        description:
            "Release your sandbox when your commands are done and you work only with files or research. The files stay. " +
            "A later `execute_command` needs `acquire_sandbox` again.",
        inputSchema: ReleaseSandboxInputSchema,
        describeCall: () => "Releasing the sandbox",
        execute: async () => {
            await lease.release();
            return ok({ status: "released" as const, message: "The sandbox is released." });
        },
    });
}
