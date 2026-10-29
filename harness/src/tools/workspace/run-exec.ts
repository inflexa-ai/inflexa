/**
 * Internal helper of the tools that run a sandbox command through the lease of their step. It wraps each sandbox
 * event in a `data-sandbox-event` part, thus `execute_command` and the container readout of `scan_inputs` report
 * progress in one shape.
 *
 * Not a registered tool — `defineTool` is called by the user-facing tools (`execute-command.ts`) which wrap this.
 */

import { err, ok, type Result } from "neverthrow";

import type { BoundLease } from "../../sandbox/leases.js";
import type { ExecResult } from "../../sandbox/types.js";
import type { EmitFn, ToolError } from "../define-tool.js";

export type RunExecArgs = {
    readonly lease: BoundLease;
    readonly command: readonly string[];
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeoutSeconds?: number;
    readonly emit: EmitFn;
};

/** The error of an exec with no lease. The order "acquire, then exec" is a rule of the code, not of a prompt. */
export const NO_SANDBOX_ERROR = "No sandbox is held. Call acquire_sandbox with the size that the command needs, then run the command again.";

export async function runSandboxExec(args: RunExecArgs): Promise<Result<ExecResult, ToolError>> {
    const ran = await args.lease.exec({ command: args.command, cwd: args.cwd, env: args.env, timeoutSeconds: args.timeoutSeconds }, (event) =>
        args.emit({ type: "data-sandbox-event", data: { event } }),
    );
    if (ran.isOk()) return ok(ran.value);
    const detail = ran.error.detail === undefined ? "" : ` (${ran.error.detail})`;
    return err({ error: `${NO_SANDBOX_ERROR}${detail}`, retryable: false });
}
