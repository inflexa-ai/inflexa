/**
 * The render-and-preview tool of a report session.
 *
 * The tool renders the current draft of a thread. It runs the finish first, because a mid-composition
 * draft is not a `ReportDocument`. A gap list returns as data, and no render runs. On a pass the tool
 * resolves each reference through the injected resolver, bridges the resolved values into the render model,
 * and renders the page.
 *
 * The renderer writes no file. It gives the page and the data asset of each table, and this tool stages
 * them beside the figures. The stage is authoritative over the assets directory: what this preview wrote
 * stays, and each other file goes.
 *
 * The page and its staged assets land in `report-sessions/{threadId}/` under the workspace root. That
 * namespace belongs to this path alone, thus the tool never writes under the old `previews/` or `reports/`
 * trees. The result carries the absolute page path, thus a local host shows the page with no seam.
 *
 * The result carries no access grant. `PreviewPublisher` authorizes the URL space
 * `previews/{analysisId}/{previewId}` (`contracts/content-url.ts`), and that space cannot name a page of
 * this tree. A hosted view of a session page is a later capability, with a URL space of its own.
 *
 * Each degraded condition is a typed outcome in the ok channel: a session refusal, a gap list, a resolver
 * absence, an unresolvable root at resolver construction, an unresolved reference, a bridge mismatch, a
 * render problem, a figure that escapes the workspace root, a write failure, and a stamp failure. The tool
 * never throws for one of them. When the page
 * lands, the tool stamps the hash of the rendered draft on the session state, thus the eyes and the record
 * know which draft the page shows. The filesystem speaks the
 * throw protocol, and the workspace-root seam signals an unresolvable resource the same way. Thus the
 * write runs through the `tryFs` glue, which turns a genuine fault into the ok-channel outcome and lets a
 * control-flow exception propagate.
 */

import { err, ok, type Result } from "neverthrow";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";

import { reportSessionDir, resolveWorkspacePath, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import type { AuthContext } from "../../auth/types.js";
import type { Block, ReportDocument } from "../../contracts/report-blocks.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { describeFsError, tryFsWrite, type FsError } from "../../lib/fs-result.js";
import { defaultErrorFields, type Logger } from "../../lib/logger.js";
import { computeDraftHash } from "../../report-model/draft-hash.js";
import { finishDraft, type FinishGap } from "../../report-model/draft-finish.js";
import type { ReferenceResolver, ReportSnapshot, ResolvedValue } from "../../report-model/reference-resolver.js";
import { resolveDocumentReferences, type ResolutionFailure } from "../../report-model/validate.js";
import { bridgeValues, type BlockResolution, type BridgeMismatch, type ResolvedFile } from "../../report-render/value-bridge.js";
import { resolvePageAssetFromInstallation } from "../../report-render/asset-lookup.js";
import { ASSETS_DIR, PAGE_ASSETS, tableSidecarName } from "../../report-render/assets.js";
import { renderReportPage } from "../../report-render/render.js";
import type { DataAsset } from "../../report-render/table-data.js";
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
    | { outcome: "root-unresolvable"; detail: string }
    | { outcome: "unresolved-references"; unresolved: ResolutionFailure[] }
    | { outcome: "bridge-mismatch"; mismatches: BridgeMismatch[] }
    | { outcome: "render-problems"; problems: RenderProblem[] }
    | { outcome: "figure-out-of-scope"; blockId: string; path: string }
    | { outcome: "write-failed"; detail: string }
    | { outcome: "stamp-failed"; pagePath: string; detail: string }
    | { outcome: "rendered"; pagePath: string };

/**
 * The lookup of the source file of one staged asset. It maps the module specifier of a manifest entry
 * (`report-render/assets.ts`) onto an absolute path on disk.
 */
export type ResolvePageAsset = (specifier: string) => string;

/**
 * The construction deps of the preview tool.
 *
 * `resolveWorkspaceRoot` maps the analysis of the call onto its workspace root, thus one singleton tool
 * serves every analysis and it resolves the root per call from the scope. `makeResolver` is optional, because
 * a resolver realization can be absent. It binds one analysis, thus the tool makes the resolver over the
 * scope of the call.
 *
 * `resolvePageAsset` is optional, and absent it resolves each specifier against the installation of the
 * harness. An embedder that ships the asset bytes packed, for example a compiled single-file binary with no
 * `node_modules` tree, materializes them to disk and binds its own lookup here.
 */
export interface PreviewReportToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly makeResolver?: (scope: { analysisId: string; auth: AuthContext }) => ReferenceResolver;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly resolvePageAsset?: ResolvePageAsset;
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
 * One staged copy of the raw bytes of a table: the staged name, the analysis-relative path of the pinned
 * artifact, and the block whose card links it.
 */
interface TableSidecar {
    readonly blockId: string;
    readonly name: string;
    readonly path: string;
}

/**
 * The sidecar of each table block of the document, in document order.
 *
 * A table card offers the whole table as a download, and the download is the pinned file itself and never a
 * re-serialization of it. The card spells the staged name through `tableSidecarName`, thus the stage reads
 * that same function and the link and the file cannot disagree.
 *
 * A chart binds a table too, and it holds no card. Thus the walk reads the table blocks alone.
 */
function collectTableSidecars(blocks: readonly Block[]): TableSidecar[] {
    const sidecars: TableSidecar[] = [];
    const visit = (block: Block): void => {
        if (block.kind === "section") {
            for (const child of block.blocks) {
                visit(child);
            }
            return;
        }
        if (block.kind === "table") {
            sidecars.push({ blockId: block.id, name: tableSidecarName(block.binding.hash, block.binding.path), path: block.binding.path });
        }
    };
    for (const block of blocks) {
        visit(block);
    }
    return sidecars;
}

/**
 * Resolve each reference of the document, and split the resolutions from the unresolved references.
 *
 * The shared `resolveDocumentReferences` walks the tree, resolves each reference under the concurrency
 * bound, and runs the chart-encoding match, thus the preview and the record gate refuse the same
 * references. On a clean pass the resolutions map onto the render model in document order.
 */
async function resolveDocument(
    document: ReportDocument,
    resolver: ReferenceResolver,
    snapshot: ReportSnapshot,
): Promise<{ resolutions: BlockResolution[]; unresolved: ResolutionFailure[] }> {
    const { resolvedByBlock, failures } = await resolveDocumentReferences(document.sections, snapshot, resolver);
    if (failures.length > 0) {
        return { resolutions: [], unresolved: failures };
    }
    return { resolutions: collectResolutions(document.sections, resolvedByBlock), unresolved: [] };
}

/**
 * The failure of the write pipeline. An `fs` fault or an unresolvable root rides `fs`. A figure whose
 * source escapes the workspace root rides `figure-out-of-scope`, and it names the block.
 */
type PreviewWriteFailure = { kind: "fs"; error: FsError } | { kind: "figure-out-of-scope"; blockId: string; path: string };

/**
 * Resolve the page root, stage each bound image and each manifest entry, and write the page.
 *
 * The workspace-root seam signals an unresolvable resource by a throw, thus the resolution sits inside
 * the protection and its throw becomes a value. Each `fs` call runs through `tryFsWrite`, the one
 * sanctioned `fs` guard, thus a genuine I/O fault becomes a value and a control-flow exception such as a
 * cancellation propagates.
 *
 * A bound figure names a snapshot path, which is untrusted. A registered `../../` path escapes the root,
 * thus the containment test runs before any copy and reuses the one workspace-path resolver. A source
 * outside the root refuses and names the block, and no copy runs.
 *
 * The page references the chart runtime and the fonts under the same `assets/` directory, thus one copy
 * loop stages the figures, the table sidecars, and the manifest entries together. The manifest is never
 * empty, thus the assets directory exists beside every page.
 *
 * The data assets are the one part that the renderer produces rather than the disk. They write after the
 * copies and before the page. The sweep then runs, and the directory holds the closure of this page alone.
 */
async function renderToWorkspace(args: {
    resolveWorkspaceRoot: ResolveWorkspaceRoot;
    resolvePageAsset: ResolvePageAsset;
    analysisId: string;
    threadId: string;
    resolutions: readonly BlockResolution[];
    sidecars: readonly TableSidecar[];
    dataAssets: readonly DataAsset[];
    page: string;
    logger: Logger;
}): Promise<Result<string, PreviewWriteFailure>> {
    let root: string;
    try {
        root = args.resolveWorkspaceRoot(args.analysisId);
    } catch (cause) {
        return err({ kind: "fs", error: { type: "read_failed", op: "preview.resolveWorkspaceRoot", path: args.analysisId, cause } });
    }

    const sessionDir = join(root, reportSessionDir(args.threadId));
    // The page addresses each staged file through `assetSource`, which spells the same segment. Thus the
    // directory that receives the copies comes from that one constant, and never from a literal here.
    const assetsDir = join(sessionDir, ASSETS_DIR);
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

    // Each table sidecar: the pinned bytes themselves, under the name that the download link of the card
    // spells. The path of a snapshot entry is untrusted, thus the containment test runs here too.
    for (const sidecar of args.sidecars) {
        if (sources.has(sidecar.name)) {
            continue;
        }
        const resolved = resolveWorkspacePath({ workspaceRoot: root, analysisId: args.analysisId, path: sidecar.path });
        if (resolved.kind !== "ok") {
            return err({ kind: "figure-out-of-scope", blockId: sidecar.blockId, path: sidecar.path });
        }
        sources.set(sidecar.name, resolved.absolute);
    }

    // Each manifest entry, mapped from its staged name to the file that the asset lookup gives. A specifier
    // that does not resolve is a fault of the installation, thus it rides the `fs` kind.
    for (const asset of PAGE_ASSETS) {
        try {
            sources.set(asset.file, args.resolvePageAsset(asset.specifier));
        } catch (cause) {
            return err({ kind: "fs", error: { type: "read_failed", op: "preview.resolveAsset", path: asset.specifier, cause } });
        }
    }

    const madeSession = await tryFsWrite("preview.mkdir", () => mkdir(sessionDir, { recursive: true }), { path: sessionDir });
    if (madeSession.isErr()) {
        return err({ kind: "fs", error: madeSession.error });
    }
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
    // Each data asset is source text that the renderer derived, thus it writes and never copies.
    for (const asset of args.dataAssets) {
        const assetPath = join(assetsDir, asset.name);
        const wroteAsset = await tryFsWrite("preview.writeFile", () => writeFile(assetPath, asset.bytes, "utf8"), { path: assetPath });
        if (wroteAsset.isErr()) {
            return err({ kind: "fs", error: wroteAsset.error });
        }
    }
    const wrote = await tryFsWrite("preview.writeFile", () => writeFile(pagePath, args.page, "utf8"), { path: pagePath });
    if (wrote.isErr()) {
        return err({ kind: "fs", error: wrote.error });
    }

    const staged = new Set<string>([...sources.keys(), ...args.dataAssets.map((asset) => asset.name)]);
    await sweepAssets(assetsDir, staged, args.logger);
    return ok(pagePath);
}

/**
 * Remove each file of the assets directory that this preview did not stage.
 *
 * The stage is authoritative: the directory holds the closure of the page and nothing else. A block that
 * goes leaves a stale data asset, a stale sidecar, and a stale figure behind, and each one costs disk and
 * misleads a reader who opens the directory. The staged set is what this run wrote, thus the sweep needs no
 * read of the page.
 *
 * A sweep fault costs the cleanup alone. The page and its assets are on disk and complete, thus a failed
 * listing and a failed removal each log and the preview still reports the page.
 */
async function sweepAssets(assetsDir: string, staged: ReadonlySet<string>, logger: Logger): Promise<void> {
    const listed = await tryFsWrite("preview.readdir", () => readdir(assetsDir), { path: assetsDir });
    if (listed.isErr()) {
        logger.warn("the assets directory did not list", { path: assetsDir, detail: describeFsError(listed.error) });
        return;
    }
    for (const entry of listed.value) {
        if (staged.has(entry)) {
            continue;
        }
        const stale = join(assetsDir, entry);
        const removed = await tryFsWrite("preview.rm", () => rm(stale, { force: true, recursive: true }), { path: stale });
        if (removed.isErr()) {
            logger.warn("a stale asset did not go", { path: stale, detail: describeFsError(removed.error) });
        }
    }
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
    const resolvePageAsset = deps.resolvePageAsset ?? resolvePageAssetFromInstallation;

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
        // The page path is the one fact of a preview that a watcher wants, and it exists only in the
        // result. Each other arm is a degraded condition whose kind already names it, thus the kind
        // stands as the line. A stamp failure is such an arm: the page landed, but the marker did not,
        // and a line that named the page would read as a clean pass.
        describeResult: (_input, result): string => (result.outcome === "rendered" ? `page ${result.pagePath}` : result.outcome),
        execute: async (_input, ctx): Promise<Result<PreviewReportResult, ToolError>> => {
            const opened = await openReportThread(deps.gateway, ctx.session.scope);
            if (opened.isErr()) {
                return ok({ outcome: "refused", refusal: opened.error });
            }
            const { threadId, analysisId, state, derivations } = opened.value;
            const { document: draft, snapshot } = state;

            const finished = finishDraft(draft, snapshot, derivations);
            if (!finished.valid) {
                return ok({ outcome: "gaps", gaps: finished.gaps });
            }
            const document = finished.document;

            if (deps.makeResolver === undefined) {
                return ok({ outcome: "resolver-unavailable" });
            }
            // The resolver construction resolves the workspace root inside, and that seam throws on an
            // unresolvable root. The guard turns the throw into a typed outcome that names the fault, thus a
            // control-flow exception propagates and the unresolvable root does not.
            let resolver: ReferenceResolver;
            try {
                resolver = deps.makeResolver({ analysisId, auth: ctx.session.auth });
            } catch (cause) {
                logger.warn("the workspace root did not resolve", { threadId, analysisId, ...defaultErrorFields(cause) });
                return ok({ outcome: "root-unresolvable", detail: "the workspace root did not resolve" });
            }

            const { resolutions, unresolved } = await resolveDocument(document, resolver, snapshot);
            if (unresolved.length > 0) {
                return ok({ outcome: "unresolved-references", unresolved });
            }

            const bridged = bridgeValues(resolutions, figureSourcePolicy);
            if (bridged.isErr()) {
                return ok({ outcome: "bridge-mismatch", mismatches: bridged.error });
            }

            // The citation records are the bibliography of the pin, and the derivation records are the chain
            // of each derived path. Both ride the render call and never the value map, because the appendix
            // reads them beside the cards and the value map is keyed by block.
            const rendered = renderReportPage(document, bridged.value, snapshot.citationRecords, derivations);
            if (rendered.isErr()) {
                return ok({ outcome: "render-problems", problems: rendered.error });
            }

            const written = await renderToWorkspace({
                resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
                resolvePageAsset,
                analysisId,
                threadId,
                resolutions,
                sidecars: collectTableSidecars(document.sections),
                dataAssets: rendered.value.dataAssets,
                page: rendered.value.html,
                logger,
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

            // The page shows the draft that the finish read. The stamp records that draft, thus the eyes
            // copy this hash and the record compares against it. A failed stamp is a transient store fault,
            // and the page stays on disk. The agent runs the preview again to stamp the marker.
            const stamped = await deps.gateway.stampRendered(threadId, computeDraftHash(draft));
            if (stamped.outcome !== "stamped") {
                const detail = stamped.outcome === "failed" ? stamped.detail : "the session state row is absent";
                logger.warn("the rendered hash did not stamp", { threadId, analysisId, detail });
                return ok({ outcome: "stamp-failed", pagePath: written.value, detail });
            }

            return ok({ outcome: "rendered", pagePath: written.value });
        },
    });
}
