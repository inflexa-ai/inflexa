/**
 * The workspace mutate seam — `{ writeFile }` confined to one agent's writable
 * working directory. The write-side counterpart to `WorkspaceFilesystem`
 * (see the harness-workspace-tools spec).
 *
 * It lives here (next to `run-exec`) rather than under `workspace/` because the
 * write path is sandbox-coupled: a write is one `SandboxClient` exec, not a
 * host `fs` call. The seam owns the whole gauntlet that `write_file` and
 * `edit_file` previously each re-implemented inline — resolve + confine to the
 * working directory, derive the in-sandbox path, and write the bytes through
 * the sandbox — so the confinement invariant is concentrated in one place
 * instead of being a per-tool convention.
 */

import { computeSha256 } from "../../lib/fs-helpers.js";
import type { ProvenanceCollector } from "../../provenance/collector.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { SandboxRef } from "../../sandbox/types.js";
import { resolveForWrite } from "../../workspace/paths.js";
import type { EmitFn } from "../define-tool.js";
import { boundExecResult, type BoundedExecResult } from "./result-bounds.js";
import { runSandboxExec } from "./run-exec.js";

/** Outcome of a confined write. Expected outcomes are data variants — never throws. */
export type WriteFileResult =
    | { readonly status: "ok"; readonly path: string; readonly bytesWritten: number }
    | { readonly status: "out_of_scope"; readonly path: string }
    | { readonly status: "out_of_prefix"; readonly path: string }
    | ({ readonly status: "write_failed"; readonly path: string } & BoundedExecResult);

/**
 * Agent-visible name of the tool driving a confined write. Rides the write args
 * so a successful write is attributed to the invoking tool in provenance
 * (`inflexa:tool` in the signed document) — the seam records the write without
 * inspecting its caller.
 */
export type MutateToolName = "write_file" | "edit_file";

export interface WorkspaceMutatorDeps {
    readonly sandboxClient: SandboxClient;
    readonly sandbox: SandboxRef;
    /** Absolute host root of this analysis's workspace tree — used by the resolver. */
    readonly workspaceRoot: string;
    readonly analysisId: string;
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
    /**
     * Step-scoped lineage collector. On a successful confined write the seam
     * records a file-tool provenance record here — hash and size computed
     * in-process from the exact bytes written. Omit to skip recording; the
     * write itself proceeds unchanged.
     */
    readonly lineageCollector?: ProvenanceCollector;
}

export interface WorkspaceMutator {
    /**
     * Resolve `path` against the working directory (relative) or analysis root
     * (absolute `/{analysisId}/...`), confine the result to the working
     * directory, and write `content` through the sandbox. `toolName` names the
     * invoking tool so a successful write is attributed to it in provenance.
     */
    writeFile(args: { readonly path: string; readonly content: string; readonly toolName: MutateToolName; readonly emit: EmitFn }): Promise<WriteFileResult>;
}

const WRITE_BYTES_PROGRAM = [
    "import sys,base64,os",
    "p=sys.argv[1]",
    "os.makedirs(os.path.dirname(p), exist_ok=True)",
    "open(p,'wb').write(base64.b64decode(sys.argv[2]))",
].join("\n");

export function createWorkspaceMutator(deps: WorkspaceMutatorDeps): WorkspaceMutator {
    return {
        async writeFile({ path, content, toolName, emit }) {
            const scoped = resolveForWrite({
                workspaceRoot: deps.workspaceRoot,
                analysisId: deps.analysisId,
                workingDir: deps.workingDir,
                path,
            });
            if (scoped.kind === "out_of_scope") return { status: "out_of_scope", path };
            if (scoped.kind === "out_of_prefix") return { status: "out_of_prefix", path };

            // Analysis-root-relative, forward-slashed: the sandbox path prepends
            // the `/{analysisId}` mount; the provenance record uses the bare tail
            // (the collector normalizes it step-relative itself).
            const relative = scoped.relative.split("\\").join("/");
            const sandboxPath = `/${deps.analysisId}/${relative}`;
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

            // Attest the write in-process from the exact bytes just written — the
            // seam owns write provenance the same way it owns confinement. The
            // sandbox exec frame this write produces is deliberately not fed to
            // `feedExecFrame`: doing so would mint a `python3`+base64 command
            // record, the very misattribution this file-tool record supersedes.
            //
            // `timestamp` is a write-time wall clock — normally a replay hazard in
            // provenance, but safe here because the record contributes only producer
            // IDENTITY downstream: the bridge drops it (the cli's file-tool ref has no
            // timestamp field) and the signed `inflexa:FileToolWrite` activity carries
            // just the tool name, so a re-execution's fresh stamp changes nothing in
            // the attested graph. Do NOT start forwarding it into an identifier or a
            // formal PROV position without making it replay-stable first.
            if (deps.lineageCollector) {
                deps.lineageCollector.recordFileToolWrite({
                    path: relative,
                    hash: computeSha256(contentBytes),
                    size: contentBytes.length,
                    toolName,
                    timestamp: new Date().toISOString(),
                });
            }

            return { status: "ok", path: sandboxPath, bytesWritten: contentBytes.length };
        },
    };
}
