/**
 * The pinned-artifact listing tool of a report session.
 *
 * The tool reads the frozen snapshot of the thread, and it gives the whole pinned set: the path, the
 * content hash, the file type, and the header columns of a tabular artifact. Thus one call orients the
 * agent, and a reference binds to a path that this listing names.
 *
 * The order is the code-unit order of the path. Two calls over one snapshot give one listing, thus the
 * agent reads a stable set.
 *
 * The columns come from a bounded header read. The path of a snapshot entry is untrusted, thus the read
 * contains it with the one workspace-path resolver first. A file type that holds no cell reads nothing,
 * because such a file carries no column.
 *
 * An absent file, an unreadable file, and an unresolvable workspace root each give no columns and no
 * error. Absence is a normal condition here: the listing is orientation, and the hash is the evidence.
 */

import { ok, type Result } from "neverthrow";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";

import { resolveWorkspacePath, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { tryFs } from "../../lib/fs-result.js";
import { defaultErrorFields, type Logger } from "../../lib/logger.js";
import { fileTypeHoldsNoCell } from "../../report-model/reference-resolver.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { openReportThread, type ReportSessionStateGateway, type SessionRefusal } from "../report-authoring/authoring-tools.js";

/** The empty input. The tool lists the pinned set of the thread, thus it needs no field. */
const listPinnedArtifactsInput = z.object({});

export type ListPinnedArtifactsInput = z.infer<typeof listPinnedArtifactsInput>;

/**
 * One pinned artifact of the listing.
 *
 * `fileType` states a role, and it does not state a data format. `columns` is present only for a header
 * that the read recovered, thus an absent `columns` says nothing about the content of the file.
 */
export interface PinnedArtifact {
    path: string;
    hash: string;
    fileType?: string;
    columns?: string[];
}

/** The typed outcome of the listing tool. Each arm is ok-channel data, thus the tool never throws for one of them. */
export type ListPinnedArtifactsResult = { outcome: "refused"; refusal: SessionRefusal } | { outcome: "listed"; artifacts: PinnedArtifact[] };

/**
 * The construction deps of the listing tool.
 *
 * `resolveWorkspaceRoot` maps the analysis of the call onto its workspace root, thus one singleton tool
 * serves every analysis and it resolves the root per call from the scope.
 */
export interface ListPinnedArtifactsToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly logger?: Logger;
}

/**
 * The cap of the header read. A header line of an analysis output sits far under it, and a file with no
 * newline at all costs this many bytes and no more. A line that overflows the cap loses its last column
 * name, and the listing is orientation and not evidence.
 */
const HEADER_CAP_BYTES = 16 * 1024;

/** The delimiter of a tabular artifact. The extension decides it, because the bytes carry no declaration. */
function delimiterOf(path: string): string {
    return extname(path).toLowerCase() === ".tsv" ? "\t" : ",";
}

/**
 * Read the first line of a file under the cap, or give `undefined` when the bytes do not come back.
 *
 * The read takes a bounded byte window, thus a file of any size costs the cap. An absent file and a
 * genuine read fault both give `undefined`, because the listing reports no error for a header.
 */
async function readHeaderLine(absolute: string): Promise<string | undefined> {
    const head = await tryFs<string | undefined>(
        "listPinnedArtifacts.readHeader",
        async () => {
            const handle = await open(absolute, "r");
            try {
                const buffer = Buffer.alloc(HEADER_CAP_BYTES);
                const { bytesRead } = await handle.read(buffer, 0, HEADER_CAP_BYTES, 0);
                return buffer.subarray(0, bytesRead).toString("utf8");
            } finally {
                await handle.close();
            }
        },
        { path: absolute, onAbsent: () => undefined },
    ).unwrapOr(undefined);
    if (head === undefined) {
        return undefined;
    }
    const line = head.split(/\r?\n/, 1)[0];
    return line.length > 0 ? line : undefined;
}

/** Split a header line into column names on the delimiter of the path, and trim each name. */
function columnsOf(line: string, path: string): string[] {
    return line.split(delimiterOf(path)).map((name) => name.trim());
}

/**
 * Make the pinned-artifact listing tool over the session-state gateway.
 *
 * The tool reads the thread id from the scope of the call, and it loads the snapshot through the gateway.
 * Thus one factory serves every thread, and the tool holds no per-session value.
 */
export function createListPinnedArtifactsTool(deps: ListPinnedArtifactsToolDeps): Tool<ListPinnedArtifactsInput, ListPinnedArtifactsResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("list-pinned-artifacts");

    return defineTool({
        id: "list_pinned_artifacts",
        description:
            "List the pinned evidence of this session. Each entry gives the path of an artifact, its content hash, its file type, " +
            "and the header columns when the artifact holds cells and its header reads. " +
            "The pin freezes at the start of the session, thus this listing is the whole set that a reference can bind to. " +
            "Read it to orient before you bind a block, and to choose the column that a locator names. " +
            "A reference names the path alone: the session stamps the hash from this evidence.",
        inputSchema: listPinnedArtifactsInput,
        executionMode: "inline",
        describeCall: "none",
        execute: async (_input, ctx): Promise<Result<ListPinnedArtifactsResult, ToolError>> => {
            const opened = await openReportThread(deps.gateway, ctx.session.scope);
            if (opened.isErr()) {
                return ok({ outcome: "refused", refusal: opened.error });
            }
            const { threadId, analysisId, state } = opened.value;
            const paths = Object.keys(state.snapshot.artifacts).sort();

            // The seam signals an unresolvable resource by a throw. The listing still serves the path and
            // the hash of each entry, thus the fault costs the columns alone and never the whole call.
            let root: string | undefined;
            try {
                root = deps.resolveWorkspaceRoot(analysisId);
            } catch (cause) {
                logger.warn("the workspace root did not resolve", { threadId, analysisId, ...defaultErrorFields(cause) });
            }

            const artifacts: PinnedArtifact[] = [];
            for (const path of paths) {
                const entry = state.snapshot.artifacts[path];
                const fileType = entry.fileType;
                const artifact: PinnedArtifact = { path, hash: entry.hash, ...(typeof fileType === "string" ? { fileType } : {}) };
                if (root !== undefined && !fileTypeHoldsNoCell(fileType)) {
                    const resolved = resolveWorkspacePath({ workspaceRoot: root, analysisId, path });
                    if (resolved.kind === "ok") {
                        const line = await readHeaderLine(resolved.absolute);
                        if (line !== undefined) {
                            artifact.columns = columnsOf(line, path);
                        }
                    }
                }
                artifacts.push(artifact);
            }
            return ok({ outcome: "listed", artifacts });
        },
    });
}
