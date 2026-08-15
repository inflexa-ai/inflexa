/**
 * The pinned-artifact listing tool of a report session.
 *
 * The tool reads the frozen snapshot of the thread, and it gives the pinned set: the path, the content
 * hash, the file type, and the header columns of a tabular artifact, plus the pinned citation ids. Thus
 * one call orients the agent, and a reference binds to a path or to a citation id of that set.
 *
 * The order is the code-unit order of the path. Two calls over one snapshot give one listing, thus the
 * agent reads a stable set. A snapshot can pin many thousands of staged inputs, thus the listing stops at
 * a cap and it carries the total count and a truncation marker.
 *
 * The columns come from a bounded header read of a listed entry. The path of a snapshot entry is
 * untrusted, thus the read contains it with the one workspace-path resolver first. The extension gates
 * the read, because a file type states a role and not a data format.
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

/**
 * The typed outcome of the listing tool. Each arm is ok-channel data, thus the tool never throws for one
 * of them.
 *
 * `total` counts the whole pinned set, and `truncated` says that the set holds more entries than
 * `artifacts` names. Thus the agent reads a partial listing as a partial listing.
 *
 * `citations` gives the pinned citation ids in the code-unit order that the pin stored. A citation
 * reference binds to one of them, thus the agent reads an id here and never out of a refusal.
 */
export type ListPinnedArtifactsResult =
    | { outcome: "refused"; refusal: SessionRefusal }
    | { outcome: "listed"; artifacts: PinnedArtifact[]; total: number; truncated: boolean; citations: string[] };

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
 * newline at all costs this many bytes and no more.
 */
const HEADER_CAP_BYTES = 16 * 1024;

/**
 * The cap of the listing. A snapshot pins each staged input of the analysis, and such a set can hold
 * many thousands of entries. One entry costs one file read, thus the cap bounds both the reply and the
 * work of the call.
 */
const LISTING_CAP = 200;

/**
 * The two extensions that carry a header line, each with its delimiter.
 *
 * The extension decides, because the bytes carry no declaration and a file type states a role alone. A
 * minified JSON under `output/` splits into hundreds of names that address nothing, and a binary splits
 * into unreadable text. Thus an entry with another extension reads no header.
 */
const HEADER_DELIMITERS: ReadonlyMap<string, string> = new Map([
    [".csv", ","],
    [".tsv", "\t"],
]);

/** The header delimiter of a path, or `undefined` when the extension carries no header. */
function delimiterOf(path: string): string | undefined {
    return HEADER_DELIMITERS.get(extname(path).toLowerCase());
}

/**
 * The first line of a file, with the mark of a line that the window cut.
 *
 * `cut` is true when the window filled and it holds no line end. Then the bytes stop inside the header,
 * and the last name of the line is a fragment.
 */
interface HeaderRead {
    readonly line: string;
    readonly cut: boolean;
}

/**
 * Read the first line of a file under the cap, or give `undefined` when the bytes do not come back.
 *
 * The read takes a bounded byte window, thus a file of any size costs the cap. An absent file and a
 * genuine read fault both give `undefined`, because the listing reports no error for a header.
 */
async function readHeaderLine(absolute: string): Promise<HeaderRead | undefined> {
    const head = await tryFs<{ text: string; filled: boolean } | undefined>(
        "listPinnedArtifacts.readHeader",
        async () => {
            const handle = await open(absolute, "r");
            try {
                const buffer = Buffer.alloc(HEADER_CAP_BYTES);
                const { bytesRead } = await handle.read(buffer, 0, HEADER_CAP_BYTES, 0);
                return { text: buffer.subarray(0, bytesRead).toString("utf8"), filled: bytesRead === HEADER_CAP_BYTES };
            } finally {
                await handle.close();
            }
        },
        { path: absolute, onAbsent: () => undefined },
    ).unwrapOr(undefined);
    if (head === undefined) {
        return undefined;
    }
    const line = head.text.split(/\r?\n/, 1)[0];
    if (line.length === 0) {
        return undefined;
    }
    return { line, cut: head.filled && !head.text.includes("\n") };
}

/**
 * Split a header line into column names on the delimiter, or give `undefined` when no whole name comes
 * out of it.
 *
 * A double quote makes a field that can hold the delimiter itself, thus the naive split gives wrong
 * names. A cut line ends inside its last name, and an agent writes a column name into a locator. Both
 * conditions give no columns, because a wrong name is worse than an absent one.
 */
function columnsOf(read: HeaderRead, delimiter: string): string[] | undefined {
    if (read.line.includes('"')) {
        return undefined;
    }
    const names = read.line.split(delimiter).map((name) => name.trim());
    const whole = read.cut ? names.slice(0, -1) : names;
    return whole.length > 0 ? whole : undefined;
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
            "and the header columns of a .csv or a .tsv file. Another extension, a header line that holds a double quote, and a " +
            "file whose bytes do not read each give no columns. " +
            `The listing gives a maximum of ${LISTING_CAP} entries: "total" gives the size of the pinned set, and "truncated" says that the ` +
            "set holds more artifacts than this listing names. " +
            '"citations" gives the pinned citation ids of this session, each in the "idKind:id" form. A citation block binds to one of ' +
            "them, thus take an id from this list and never from a refusal. " +
            "The pin freezes at the start of the session, thus a reference binds to an artifact of this pinned set. " +
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
            // The cap cuts the tail of the same order, thus a truncated listing is a prefix of the whole
            // listing and a second call over one snapshot names the same entries.
            const listed = paths.slice(0, LISTING_CAP);

            // The seam signals an unresolvable resource by a throw. The listing still serves the path and
            // the hash of each entry, thus the fault costs the columns alone and never the whole call.
            let root: string | undefined;
            try {
                root = deps.resolveWorkspaceRoot(analysisId);
            } catch (cause) {
                logger.warn("the workspace root did not resolve", { threadId, analysisId, ...defaultErrorFields(cause) });
            }

            const artifacts: PinnedArtifact[] = [];
            for (const path of listed) {
                const entry = state.snapshot.artifacts[path];
                const fileType = entry.fileType;
                const artifact: PinnedArtifact = { path, hash: entry.hash, ...(typeof fileType === "string" ? { fileType } : {}) };
                const delimiter = delimiterOf(path);
                if (root !== undefined && delimiter !== undefined && !fileTypeHoldsNoCell(fileType)) {
                    const resolved = resolveWorkspacePath({ workspaceRoot: root, analysisId, path });
                    if (resolved.kind === "ok") {
                        const read = await readHeaderLine(resolved.absolute);
                        const columns = read === undefined ? undefined : columnsOf(read, delimiter);
                        if (columns !== undefined) {
                            artifact.columns = columns;
                        }
                    }
                }
                artifacts.push(artifact);
            }
            // The pin stores the citation keys sorted, thus the listing passes them through. A snapshot
            // that pinned no citation gives an empty list, and an empty list is a complete answer.
            const citations = state.snapshot.citations ?? [];
            return ok({ outcome: "listed", artifacts, total: paths.length, truncated: paths.length > listed.length, citations });
        },
    });
}
