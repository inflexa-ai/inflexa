/**
 * The render-and-preview tool of a report session.
 *
 * The tool renders the current draft of a thread. It runs the finish first, because a mid-composition
 * draft is not a `ReportDocument`. A gap list returns as data, and no render runs. On a pass the tool
 * resolves each reference through the injected resolver, bridges the resolved values into the render model,
 * and renders the page.
 *
 * The page and its staged image assets land in `report-sessions/{threadId}/` under the workspace root. That
 * namespace belongs to this path alone, thus the tool never writes under the old `previews/` or `reports/`
 * trees. The result carries the absolute page path, thus a local host shows the page with no seam.
 *
 * The result carries no access grant. `PreviewPublisher` authorizes the URL space
 * `previews/{analysisId}/{previewId}` (`contracts/content-url.ts`), and that space cannot name a page of
 * this tree. A hosted view of a session page is a later capability, with a URL space of its own.
 *
 * Each degraded condition is a typed outcome in the ok channel: a session refusal, a gap list, a resolver
 * absence, an unresolved reference, a bridge mismatch, a render problem, a figure that escapes the
 * workspace root, and a write failure. The tool never throws for one of them. The filesystem speaks the
 * throw protocol, and the workspace-root seam signals an unresolvable resource the same way. Thus the
 * write runs through the `tryFs` glue, which turns a genuine fault into the ok-channel outcome and lets a
 * control-flow exception propagate.
 */

import { err, ok, type Result } from "neverthrow";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";

import { resolveWorkspacePath, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import type { Block, ReportDocument } from "../../contracts/report-blocks.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { describeFsError, tryFsWrite, type FsError } from "../../lib/fs-result.js";
import { defaultErrorFields, type Logger } from "../../lib/logger.js";
import { allWithConcurrency } from "../../lib/async-utils.js";
import { walkBlocks } from "../../report-model/block-walk.js";
import { finishDraft, type FinishGap } from "../../report-model/draft-finish.js";
import type { ReferenceResolver, ReportSnapshot, ResolvedValue } from "../../report-model/reference-resolver.js";
import { checkChartEncoding, RESOLUTION_CONCURRENCY, type ResolutionFailure } from "../../report-model/validate.js";
import { bridgeValues, type BlockResolution, type BridgeMismatch, type ResolvedFile } from "../../report-render/value-bridge.js";
import { renderReportPage } from "../../report-render/render.js";
import type { RenderProblem } from "../../report-render/types.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { openReportThread, type ReportSessionStateGateway, type SessionRefusal } from "../report-authoring/authoring-tools.js";

/** The empty input. The tool renders the current draft of the thread, thus it needs no field. */
const previewReportInput = z.object({});

export type PreviewReportInput = z.infer<typeof previewReportInput>;

/**
 * The typed outcome of the preview tool. Each arm is ok-channel data, thus the tool never throws for a
 * degraded condition. `rendered` carries the absolute page path.
 */
export type PreviewReportResult =
    | { outcome: "refused"; refusal: SessionRefusal }
    | { outcome: "gaps"; gaps: FinishGap[] }
    | { outcome: "resolver-unavailable" }
    | { outcome: "unresolved-references"; unresolved: ResolutionFailure[] }
    | { outcome: "bridge-mismatch"; mismatches: BridgeMismatch[] }
    | { outcome: "render-problems"; problems: RenderProblem[] }
    | { outcome: "figure-out-of-scope"; blockId: string; path: string }
    | { outcome: "write-failed"; detail: string }
    | { outcome: "rendered"; pagePath: string };

/**
 * The construction deps of the preview tool.
 *
 * `resolveWorkspaceRoot` maps the analysis of the call onto its workspace root, thus one singleton tool
 * serves every analysis and it resolves the root per call from the scope. `resolver` is optional, because a
 * resolver realization can be absent.
 */
export interface PreviewReportToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly resolver?: ReferenceResolver;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly logger?: Logger;
}

/**
 * The staged file name of one bound image: its content hash with the original extension.
 *
 * The colon of the `algorithm:hex` hash is not safe in a file name and in a relative source, thus the slug
 * replaces each non-word run with one dash. The hash is unique, thus two figures with one basename cannot
 * collide on the staged name.
 */
function assetFileName(file: ResolvedFile): string {
    const slug = file.hash.replace(/[^a-z0-9]+/gi, "-");
    return slug + extname(file.path);
}

/** The relative source of a staged figure. The page directory is self-contained, thus the source is `assets/<name>`. */
function figureSourcePolicy(file: ResolvedFile): string {
    return `assets/${assetFileName(file)}`;
}

/**
 * Pair each block with the resolved value of its binding, in document order.
 *
 * A value-bearing kind carries the resolved value of its one reference, looked up by the block id from
 * the map that the resolution pass filled. A no-value kind carries none. Where a reference sits in a
 * block is the knowledge of `block-walk.ts`, thus this walk reads the block id alone and never a binding
 * field.
 *
 * The switch is exhaustive over the eight block kinds. A ninth kind reaches the end with no return, and
 * the declared return type fails the build. Thus the walk cannot drop a kind in silence. A value-bearing
 * block reaches here only when its reference resolved, because an unresolved reference short-circuits
 * before this walk.
 */
function collectResolutions(blocks: readonly Block[], resolvedByBlock: ReadonlyMap<string, ResolvedValue>): BlockResolution[] {
    const resolutions: BlockResolution[] = [];
    const visit = (block: Block): void => {
        switch (block.kind) {
            case "section":
                resolutions.push({ blockId: block.id, kind: "section" });
                for (const child of block.blocks) {
                    visit(child);
                }
                return;
            case "text":
            case "claim":
            case "citation":
                resolutions.push({ blockId: block.id, kind: block.kind });
                return;
            case "metric":
            case "table":
            case "chart":
            case "figure": {
                const resolved = resolvedByBlock.get(block.id);
                if (resolved !== undefined) {
                    resolutions.push({ blockId: block.id, kind: block.kind, resolved });
                }
                return;
            }
        }
    };
    for (const block of blocks) {
        visit(block);
    }
    return resolutions;
}

/**
 * Resolve each reference of the document, and collect the resolutions and the unresolved references.
 *
 * The reference collection, the concurrency bound, and the chart-encoding match come from the mechanical
 * validator, thus the preview and the record gate refuse the same references. `walkBlocks` collects the
 * references one time, `allWithConcurrency` bounds the fan-out the same as `validateReport`, and
 * `checkChartEncoding` catches a chart that plots a column which the bound table does not hold.
 */
async function resolveDocument(
    document: ReportDocument,
    resolver: ReferenceResolver,
    snapshot: ReportSnapshot,
): Promise<{ resolutions: BlockResolution[]; unresolved: ResolutionFailure[] }> {
    const { references } = walkBlocks(document.sections);
    const resolved = await allWithConcurrency(
        references.map((entry) => () => resolver.resolve(entry.reference, snapshot).then((result) => ({ entry, result }))),
        RESOLUTION_CONCURRENCY,
    );

    const unresolved: ResolutionFailure[] = [];
    const resolvedByBlock = new Map<string, ResolvedValue>();
    for (const { entry, result } of resolved) {
        if (result.isErr()) {
            unresolved.push({ blockId: entry.blockId, failure: result.error });
            continue;
        }
        const encodingFailure = checkChartEncoding(entry, result.value);
        if (encodingFailure !== undefined) {
            unresolved.push({ blockId: entry.blockId, failure: encodingFailure });
            continue;
        }
        // A value-bearing block holds one reference, thus the block id keys its one resolved value. A
        // claim or a citation reference lands here too, and its block reads no value from this map.
        resolvedByBlock.set(entry.blockId, result.value);
    }

    if (unresolved.length > 0) {
        return { resolutions: [], unresolved };
    }
    return { resolutions: collectResolutions(document.sections, resolvedByBlock), unresolved };
}

/**
 * The failure of the write pipeline. An `fs` fault or an unresolvable root rides `fs`. A figure whose
 * source escapes the workspace root rides `figure-out-of-scope`, and it names the block.
 */
type PreviewWriteFailure = { kind: "fs"; error: FsError } | { kind: "figure-out-of-scope"; blockId: string; path: string };

/**
 * Resolve the page root, stage each bound image, and write the page.
 *
 * The workspace-root seam signals an unresolvable resource by a throw, thus the resolution sits inside
 * the protection and its throw becomes a value. Each `fs` call runs through `tryFsWrite`, the one
 * sanctioned `fs` guard, thus a genuine I/O fault becomes a value and a control-flow exception such as a
 * cancellation propagates.
 *
 * A bound figure names a snapshot path, which is untrusted. A registered `../../` path escapes the root,
 * thus the containment test runs before any copy and reuses the one workspace-path resolver. A source
 * outside the root refuses and names the block, and no copy runs.
 */
async function renderToWorkspace(args: {
    resolveWorkspaceRoot: ResolveWorkspaceRoot;
    analysisId: string;
    threadId: string;
    resolutions: readonly BlockResolution[];
    page: string;
}): Promise<Result<string, PreviewWriteFailure>> {
    let root: string;
    try {
        root = args.resolveWorkspaceRoot(args.analysisId);
    } catch (cause) {
        return err({ kind: "fs", error: { type: "read_failed", op: "preview.resolveWorkspaceRoot", path: args.analysisId, cause } });
    }

    const sessionDir = join(root, "report-sessions", args.threadId);
    const assetsDir = join(sessionDir, "assets");
    const pagePath = join(sessionDir, "index.html");

    // Each bound figure, contained and deduplicated by its staged name, mapped to its host source.
    const sources = new Map<string, string>();
    for (const resolution of args.resolutions) {
        if (resolution.kind !== "figure" || resolution.resolved.type !== "file") {
            continue;
        }
        const file: ResolvedFile = resolution.resolved;
        const name = assetFileName(file);
        if (sources.has(name)) {
            continue;
        }
        const resolved = resolveWorkspacePath({ workspaceRoot: root, analysisId: args.analysisId, path: file.path });
        if (resolved.kind !== "ok") {
            return err({ kind: "figure-out-of-scope", blockId: resolution.blockId, path: file.path });
        }
        sources.set(name, resolved.absolute);
    }

    const madeSession = await tryFsWrite("preview.mkdir", () => mkdir(sessionDir, { recursive: true }), { path: sessionDir });
    if (madeSession.isErr()) {
        return err({ kind: "fs", error: madeSession.error });
    }
    if (sources.size > 0) {
        const madeAssets = await tryFsWrite("preview.mkdir", () => mkdir(assetsDir, { recursive: true }), { path: assetsDir });
        if (madeAssets.isErr()) {
            return err({ kind: "fs", error: madeAssets.error });
        }
        for (const [name, source] of sources) {
            const copied = await tryFsWrite("preview.copyFile", () => copyFile(source, join(assetsDir, name)), { path: source });
            if (copied.isErr()) {
                return err({ kind: "fs", error: copied.error });
            }
        }
    }
    const wrote = await tryFsWrite("preview.writeFile", () => writeFile(pagePath, args.page, "utf8"), { path: pagePath });
    if (wrote.isErr()) {
        return err({ kind: "fs", error: wrote.error });
    }
    return ok(pagePath);
}

/**
 * Make the render-and-preview tool over the session-state gateway and the render seams.
 *
 * The tool reads the thread id from the scope of the call, and it loads the state through the gateway. Thus
 * one factory serves every thread. The tool holds no per-session value, and it resolves the root of the
 * analysis of the call.
 */
export function createPreviewReportTool(deps: PreviewReportToolDeps): Tool<PreviewReportInput, PreviewReportResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("preview-report");

    return defineTool({
        id: "preview_report",
        description:
            "Render the current draft to a self-contained HTML page, and give back the page path. " +
            "The tool finishes the draft first: an incomplete draft gives back the gap list, and no page renders. " +
            "On a pass it resolves each reference, stages each bound image beside the page, and writes the page. " +
            "Use it to see the report, and to confirm that each reference resolves.",
        inputSchema: previewReportInput,
        executionMode: "inline",
        describeCall: "none",
        execute: async (_input, ctx): Promise<Result<PreviewReportResult, ToolError>> => {
            const opened = await openReportThread(deps.gateway, ctx.session.scope);
            if (opened.isErr()) {
                return ok({ outcome: "refused", refusal: opened.error });
            }
            const { threadId, analysisId, state } = opened.value;
            const { document: draft, snapshot } = state;

            const finished = finishDraft(draft, snapshot);
            if (!finished.valid) {
                return ok({ outcome: "gaps", gaps: finished.gaps });
            }
            const document = finished.document;

            if (deps.resolver === undefined) {
                return ok({ outcome: "resolver-unavailable" });
            }

            const { resolutions, unresolved } = await resolveDocument(document, deps.resolver, snapshot);
            if (unresolved.length > 0) {
                return ok({ outcome: "unresolved-references", unresolved });
            }

            const bridged = bridgeValues(resolutions, figureSourcePolicy);
            if (bridged.isErr()) {
                return ok({ outcome: "bridge-mismatch", mismatches: bridged.error });
            }

            const rendered = renderReportPage(document, bridged.value);
            if (rendered.isErr()) {
                return ok({ outcome: "render-problems", problems: rendered.error });
            }

            const written = await renderToWorkspace({
                resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
                analysisId,
                threadId,
                resolutions,
                page: rendered.value,
            });
            if (written.isErr()) {
                const failure = written.error;
                if (failure.kind === "figure-out-of-scope") {
                    // A bound figure names a path outside the workspace root. The record gate refuses the
                    // same figure, thus the preview refuses it too and names the block.
                    logger.warn("a bound figure escapes the workspace root", { threadId, analysisId, blockId: failure.blockId, path: failure.path });
                    return ok({ outcome: "figure-out-of-scope", blockId: failure.blockId, path: failure.path });
                }
                // An unresolvable root, a full volume, and a denied write each arrive here as a value. The
                // tool contract is ok-channel data for each degraded condition, thus the fault becomes an
                // outcome. The log keeps the full fault, because the outcome carries the description alone.
                logger.warn("the page did not land", { threadId, analysisId, ...defaultErrorFields(failure.error.cause) });
                return ok({ outcome: "write-failed", detail: describeFsError(failure.error) });
            }

            return ok({ outcome: "rendered", pagePath: written.value });
        },
    });
}
