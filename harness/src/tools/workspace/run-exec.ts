/**
 * Internal helper used by dependency-bearing tools to drive one sandbox exec
 * through the `SandboxClient`. It wraps each sandbox event in a
 * `data-sandbox-event` part, thus `execute_command` and the container readout
 * of `scan_inputs` report progress in one shape.
 *
 * Not a registered tool — `defineTool` is called by the user-facing tools
 * (`execute-command.ts`) which wrap this.
 */

import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecResult, SandboxRef } from "../../sandbox/types.js";
import type { EmitFn } from "../define-tool.js";

export type RunExecArgs = {
    readonly sandboxClient: SandboxClient;
    readonly sandbox: SandboxRef;
    readonly command: readonly string[];
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeoutSeconds?: number;
    readonly deadlineMs: number;
    readonly emit: EmitFn;
};

export function runSandboxExec(args: RunExecArgs): Promise<ExecResult> {
    return args.sandboxClient.exec(
        args.sandbox,
        {
            command: args.command,
            cwd: args.cwd,
            env: args.env,
            timeoutSeconds: args.timeoutSeconds,
        },
        (event) => args.emit({ type: "data-sandbox-event", data: { event } }),
        args.deadlineMs,
    );
}
