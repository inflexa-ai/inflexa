/**
 * The workspace mutate seam — `{ writeFile }` confined to one agent's writable
 * working directory. The write-side counterpart to `WorkspaceFilesystem`
 * (see the harness-workspace-tools spec).
 *
 * It lives here (next to `run-exec`) rather than under `workspace/` because the
 * write path is sandbox-coupled: a write is one `SandboxClient` exec, not a
 * host `fs` call. The seam owns the whole gauntlet that `write_file` and
 * `edit_file` previously each re-implemented inline — resolve + confine to the
 * working directory, derive the in-sandbox path, write the bytes through the
 * sandbox, and record best-effort provenance — so the confinement invariant is
 * concentrated in one place instead of being a per-tool convention.
 */

import { createHash } from "node:crypto";

import type { SandboxClient } from "../../sandbox/client.js";
import type { SandboxRef } from "../../sandbox/types.js";
import { resolveForWrite } from "../../workspace/paths.js";
import type { ProvenanceCollector } from "../../workspace/provenance-collector.js";
import type { EmitFn } from "../define-tool.js";
import { boundExecResult, type BoundedExecResult } from "./result-bounds.js";
import { runSandboxExec } from "./run-exec.js";

/** Outcome of a confined write. Expected outcomes are data variants — never throws. */
export type WriteFileResult =
    | { readonly status: "ok"; readonly path: string; readonly bytesWritten: number }
    | { readonly status: "out_of_scope"; readonly path: string }
    | { readonly status: "out_of_prefix"; readonly path: string }
    | ({ readonly status: "write_failed"; readonly path: string } & BoundedExecResult);

export interface MutatorLogger {
    warn(message: string, err: unknown): void;
}

const defaultLogger: MutatorLogger = {
    warn: (message, err) => console.warn(`[workspace-mutator] ${message}:`, err),
};

export interface WorkspaceMutatorDeps {
    readonly sandboxClient: SandboxClient;
    readonly sandbox: SandboxRef;
    /** Host-side base path containing per-analysis subtrees — used by the resolver. */
    readonly sessionsBasePath: string;
    readonly analysisId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly workflowId: string;
    /** Absolute host working directory: relative paths resolve here AND writes are confined here. */
    readonly workingDir: string;
    /**
     * In-sandbox absolute path of `workingDir` (mirrors `execute_command`'s
     * `defaultCwd`). Passed as the write exec's `cwd` so sandbox-server roots
     * its tree-differ here and reports the written file as a live delta — an
     * empty `cwd` disables the differ, so write-only files (e.g. scripts/)
     * would never reach the live file tree.
     */
    readonly sandboxWorkingDir: string;
    readonly nextFunctionId: () => string;
    readonly deadlineMs: () => number;
    readonly provenance?: ProvenanceCollector;
    readonly logger?: MutatorLogger;
}

export interface WorkspaceMutator {
    /**
     * Resolve `path` against the working directory (relative) or analysis root
     * (absolute `/{analysisId}/...`), confine the result to the working
     * directory, write `content` through the sandbox, and record provenance.
     */
    writeFile(args: { readonly path: string; readonly content: string; readonly emit: EmitFn }): Promise<WriteFileResult>;
}

const WRITE_BYTES_PROGRAM = [
    "import sys,base64,os",
    "p=sys.argv[1]",
    "os.makedirs(os.path.dirname(p), exist_ok=True)",
    "open(p,'wb').write(base64.b64decode(sys.argv[2]))",
].join("\n");

export function createWorkspaceMutator(deps: WorkspaceMutatorDeps): WorkspaceMutator {
    const logger = deps.logger ?? defaultLogger;

    return {
        async writeFile({ path, content, emit }) {
            const scoped = resolveForWrite({
                sessionsBasePath: deps.sessionsBasePath,
                analysisId: deps.analysisId,
                workingDir: deps.workingDir,
                path,
            });
            if (scoped.kind === "out_of_scope") return { status: "out_of_scope", path };
            if (scoped.kind === "out_of_prefix") return { status: "out_of_prefix", path };

            const sandboxPath = `/${deps.analysisId}/${scoped.relative.split("\\").join("/")}`;
            const contentBytes = Buffer.from(content, "utf8");

            const execId = `${deps.workflowId}:${deps.stepId}:${deps.nextFunctionId()}`;
            const result = await runSandboxExec({
                sandboxClient: deps.sandboxClient,
                sandbox: deps.sandbox,
                execId,
                command: ["python3", "-c", WRITE_BYTES_PROGRAM, sandboxPath, contentBytes.toString("base64")],
                cwd: deps.sandboxWorkingDir,
                deadlineMs: deps.deadlineMs(),
                emit,
            });

            if (result.exitCode !== 0) {
                return { status: "write_failed", path: sandboxPath, ...boundExecResult(result) };
            }

            if (deps.provenance) {
                try {
                    await deps.provenance.recordSnapshot({
                        analysisId: deps.analysisId,
                        runId: deps.runId,
                        stepId: deps.stepId,
                        path: sandboxPath,
                        sha256: createHash("sha256").update(contentBytes).digest("hex"),
                        bytes: contentBytes.length,
                        timestamp: Date.now(),
                    });
                } catch (err) {
                    logger.warn("provenance.recordSnapshot failed", err);
                }
            }

            return { status: "ok", path: sandboxPath, bytesWritten: contentBytes.length };
        },
    };
}
