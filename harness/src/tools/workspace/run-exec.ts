/**
 * Internal helper used by dependency-bearing tools to drive one sandbox exec
 * through the `SandboxClient`. Centralises the submit/await pair, exec-id
 * derivation, and intermediate-event forwarding so all three tools share
 * one chokepoint. `write_file` / `edit_file` are layered on the workspace
 * mutator and environment introspection tools such as `list_available_refs`
 * use this same replay-safe submit/await path rather than a parallel protocol.
 *
 * Not a registered tool — `defineTool` is called by the user-facing tools
 * (`execute-command.ts`, `write-file.ts`, `edit-file.ts`) which wrap this.
 */

import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";
import type { EmitFn } from "../define-tool.js";

export interface RunExecArgs {
    readonly sandboxClient: SandboxClient;
    readonly sandbox: SandboxRef;
    readonly execId: string;
    readonly command: readonly string[];
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeoutSeconds?: number;
    readonly deadlineMs: number;
    readonly emit: EmitFn;
    /**
     * Tag the active-sandbox registry row with this execId before awaiting, so
     * the liveness watchdog can target the in-flight exec when the sandbox dies
     * mid-command. Best-effort: a registry write failure must not fail the exec.
     */
    readonly markExecActive?: (execId: string) => Promise<void>;
}

export async function runSandboxExec(args: RunExecArgs): Promise<ExecResult> {
    const body: SubmitExecBody = {
        command: [...args.command],
        execId: args.execId,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.env === undefined ? {} : { env: args.env }),
        ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
    };

    await args.sandboxClient.submitExec(args.sandbox, body);

    if (args.markExecActive) {
        try {
            await args.markExecActive(args.execId);
        } catch {
            // Watchdog targeting is a backstop; the awaitExec deadline still bounds
            // the exec if the registry tag never lands.
        }
    }

    return args.sandboxClient.awaitExec(
        args.sandbox,
        args.execId,
        (event) =>
            args.emit({
                type: "data-sandbox-event",
                data: { execId: args.execId, event },
            }),
        args.deadlineMs,
    );
}
