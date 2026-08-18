/**
 * The render-and-preview tool of a report session.
 *
 * The tool renders the current draft of a thread. It runs the finish first, because a mid-composition
 * draft is not a `ReportDocument`. A gap list returns as data, and no render runs. On a pass the tool
 * resolves each reference through the injected resolver, bridges the resolved values into the render model,
 * and renders the page.
 *
 * The renderer writes no file. It gives the page and the data asset of each table, and this tool stages
 * them beside the figures. It also writes the script of each derivation that the document references, from
 * the text of the durable record. The shipped libraries and fonts stage under `assets/deps/`, and each
 * report-side file at the root of `assets/`. The stage is authoritative over that root: what this preview
 * wrote stays, and each other file goes.
 *
 * The page and its staged assets land in `report-sessions/{threadId}/` under the workspace root. That
 * namespace belongs to this path alone, thus the tool never writes under the old `previews/` or `reports/`
 * trees. The result carries the absolute page path, thus a local host shows the page with no seam.
 *
 * A hosted view rides the same result. When the composition binds the session-page factory, the tool
 * builds the publisher over the scope of the call, mints one grant after the page lands, and the
 * `rendered` arm carries the URL of the URL space `report-sessions/{analysisId}/{threadId}`
 * (`contracts/content-url.ts`) beside the path. A refused mint rides the arm as data, and the page path
 * stays good — a broken grant surface never costs the render. An unbound factory changes nothing: the
 * arm carries no access field, and a local host opens the file.
 *
 * Each degraded condition is a typed outcome in the ok channel: a session refusal, a gap list, a resolver
 * absence, an unresolvable root at resolver construction, an unresolved reference, a bridge mismatch, a
 * render problem, a figure that escapes the workspace root, a write failure, and a stamp failure. The tool
 * never throws for one of them. When the page
 * lands, the tool stamps the hash of the rendered draft on the session state, thus the eyes and the record
 * know which draft the page shows. It then emits one durable `data-report-rendered` part, thus the
 * transcript places the render and a live client learns that a fresh page exists. The filesystem speaks the
 * throw protocol, and the workspace-root seam signals an unresolvable resource the same way. Thus the
 * write runs through the `tryFs` glue, which turns a genuine fault into the ok-channel outcome and lets a
 * control-flow exception propagate.
 */

import { err, ok, type Result } from "neverthrow";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { relative as relativePosix } from "node:path/posix";
import { z } from "zod";

import { reportSessionDir, resolveWorkspacePath, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import type { AuthContext } from "../../auth/types.js";
import { buildReportSessionUrl } from "../../contracts/content-url.js";
import type { Block, ReportDocument } from "../../contracts/report-blocks.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { describeFsError, tryFsWrite, type FsError } from "../../lib/fs-result.js";
import { defaultErrorFields, type Logger } from "../../lib/logger.js";
import { referencedPaths, walkBlocks } from "../../report-model/block-walk.js";
import { computeDraftHash } from "../../report-model/draft-hash.js";
import { finishDraft, type FinishGap } from "../../report-model/draft-finish.js";
import type { ReferenceResolver, ReportSnapshot, ResolvedValue } from "../../report-model/reference-resolver.js";
import { resolveDocumentReferences, type ResolutionFailure } from "../../report-model/validate.js";
import { bridgeValues, type BlockResolution, type BridgeMismatch, type ResolvedFile } from "../../report-render/value-bridge.js";
import { resolvePageAssetFromInstallation } from "../../report-render/asset-lookup.js";
import { ASSETS_DIR, DEPS_DIR, derivationScriptName, PAGE_ASSETS, stagedSource, tableSidecarName } from "../../report-render/assets.js";
import type { DerivationChain } from "../../report-render/references.js";
import { renderReportPage } from "../../report-render/render.js";
import type { DataAsset } from "../../report-render/table-data.js";
import type { RenderProblem } from "../../report-render/types.js";
import type { DerivationRecord } from "../../state/report-session-state.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { openReportThread, type ReportSessionStateGateway, type SessionRefusal } from "../report-authoring/authoring-tools.js";
import { describeSessionPageMintFailure, type MakeSessionPagePublisher, type SessionPageMintResult } from "./session-page-publisher.js";

/** The empty input. The tool renders the current draft of the thread, thus it needs no field. */
const previewReportInput = z.object({});

export type PreviewReportInput = z.infer<typeof previewReportInput>;

/**
 * The access grant of the hosted view, as data on the `rendered` arm. A granted mint carries the URL of
 * the served page and its expiry. A refused mint carries the described refusal, and the page path stays
 * good.
 */
export type SessionPageAccess = { granted: true; url: string; expiresAt: string } | { granted: false; detail: string };

/**
 * The typed outcome of the preview tool. Each arm is ok-channel data, thus the tool never throws for a
 * degraded condition. `rendered` carries the absolute page path, and the access grant of the hosted view
 * when the composition binds the publisher.
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
    | { outcome: "rendered"; pagePath: string; access?: SessionPageAccess };

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
 *
 * `makeSessionPages` is optional, because a local host opens the page path itself. It binds one analysis
 * and the auth of the call, like `makeResolver`, thus a realization mints under the credential of the
 * caller. Bound, the tool builds the publisher over the scope of the call, mints one grant after the page
 * lands, and attaches the URL beside the path. A refused mint rides the `rendered` arm as data, and it
 * never fails the render.
 */
export interface PreviewReportToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly makeResolver?: (scope: { analysisId: string; auth: AuthContext }) => ReferenceResolver;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly resolvePageAsset?: ResolvePageAsset;
    readonly makeSessionPages?: MakeSessionPagePublisher;
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
 * The derivation records that the document references, in the order that they landed.
 *
 * A binding names an output path, thus the used set is the intersection of the recorded paths and the paths
 * of the document. The record of a dropped block stays in the durable state, and this walk leaves it out.
 * Thus the page states the chain of what it shows, and the stage writes the script of what it states.
 */
function referencedDerivations(document: ReportDocument, derivations: readonly DerivationRecord[]): DerivationRecord[] {
    if (derivations.length === 0) {
        return [];
    }
    const named = referencedPaths(walkBlocks(document.sections).references);
    return derivations.filter((record) => named.has(record.outputPath));
}

/**
 * The chain of one record, with the two relative links that its appendix entry carries.
 *
 * The script link names the staged asset through the shared name function, thus the link and the file that
 * the stage writes cannot disagree. The output link is the path of the derived file against the directory of
 * the page. The derived table already sits inside the session directory, thus the link needs no copy.
 */
function chainOf(record: DerivationRecord, sessionDir: string): DerivationChain {
    return {
        outputPath: record.outputPath,
        sources: record.sources,
        scriptHash: record.scriptHash,
        scriptSource: stagedSource(derivationScriptName(record.scriptHash)),
        outputSource: relativePosix(sessionDir, record.outputPath),
    };
}

/**
 * The script of each referenced derivation, keyed by its staged name.
 *
 * Two records of one script text carry one hash, thus they take one name and the map holds one entry. The
 * name is content-addressed, thus an amended script stages beside no stale copy of itself and the sweep
 * removes the name that the new page does not reference.
 */
function scriptAssets(records: readonly DerivationRecord[]): Map<string, string> {
    const scripts = new Map<string, string>();
    for (const record of records) {
        scripts.set(derivationScriptName(record.scriptHash), record.script);
    }
    return scripts;
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
 * The page references the chart runtime and the fonts under `assets/deps/`, and each report-side file at
 * the root of `assets/`. Each manifest entry names its own subpath, thus the copy loop reads the manifest
 * and it spells no layout of its own. The manifest is never empty, thus both directories exist beside every
 * page.
 *
 * The data assets and the derivation scripts are the parts that this preview produces rather than the disk.
 * They write after the copies and before the page. The sweep then runs, and the root of the directory holds
 * the closure of this page alone.
 */
async function renderToWorkspace(args: {
    resolveWorkspaceRoot: ResolveWorkspaceRoot;
    resolvePageAsset: ResolvePageAsset;
    analysisId: string;
    threadId: string;
    resolutions: readonly BlockResolution[];
    sidecars: readonly TableSidecar[];
    dataAssets: readonly DataAsset[];
    scripts: ReadonlyMap<string, string>;
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
    const depsDir = join(assetsDir, DEPS_DIR);
    const pagePath = join(sessionDir, "index.html");

    // Each bound figure, contained and deduplicated by its staged name, mapped to its host source.
    const reportFiles = new Map<string, string>();
    for (const resolution of args.resolutions) {
        if (resolution.kind !== "figure" || resolution.resolved.type !== "file") {
            continue;
        }
        const file: ResolvedFile = resolution.resolved;
        const name = assetFileName(file);
        if (reportFiles.has(name)) {
            continue;
        }
        const resolved = resolveWorkspacePath({ workspaceRoot: root, analysisId: args.analysisId, path: file.path });
        if (resolved.kind !== "ok") {
            return err({ kind: "figure-out-of-scope", blockId: resolution.blockId, path: file.path });
        }
        reportFiles.set(name, resolved.absolute);
    }

    // Each table sidecar: the pinned bytes themselves, under the name that the download link of the card
    // spells. The path of a snapshot entry is untrusted, thus the containment test runs here too.
    for (const sidecar of args.sidecars) {
        if (reportFiles.has(sidecar.name)) {
            continue;
        }
        const resolved = resolveWorkspacePath({ workspaceRoot: root, analysisId: args.analysisId, path: sidecar.path });
        if (resolved.kind !== "ok") {
            return err({ kind: "figure-out-of-scope", blockId: sidecar.blockId, path: sidecar.path });
        }
        reportFiles.set(sidecar.name, resolved.absolute);
    }

    // Each manifest entry, mapped from its staged subpath to the file that the asset lookup gives. A
    // specifier that does not resolve is a fault of the installation, thus it rides the `fs` kind.
    const depsFiles = new Map<string, string>();
    for (const asset of PAGE_ASSETS) {
        try {
            depsFiles.set(asset.file, args.resolvePageAsset(asset.specifier));
        } catch (cause) {
            return err({ kind: "fs", error: { type: "read_failed", op: "preview.resolveAsset", path: asset.specifier, cause } });
        }
    }

    const madeSession = await tryFsWrite("preview.mkdir", () => mkdir(sessionDir, { recursive: true }), { path: sessionDir });
    if (madeSession.isErr()) {
        return err({ kind: "fs", error: madeSession.error });
    }
    // The recursive make covers the assets directory itself, thus one call answers for both levels.
    const madeAssets = await tryFsWrite("preview.mkdir", () => mkdir(depsDir, { recursive: true }), { path: depsDir });
    if (madeAssets.isErr()) {
        return err({ kind: "fs", error: madeAssets.error });
    }
    for (const [name, source] of [...reportFiles, ...depsFiles]) {
        const copied = await tryFsWrite("preview.copyFile", () => copyFile(source, join(assetsDir, name)), { path: source });
        if (copied.isErr()) {
            return err({ kind: "fs", error: copied.error });
        }
    }
    // A data asset is source text that the renderer derived, and a script is the text of a durable record.
    // Neither one sits on disk under its staged name, thus both write and neither one copies.
    const texts: Array<[string, string]> = [...args.dataAssets.map((asset): [string, string] => [asset.name, asset.bytes]), ...args.scripts];
    for (const [name, text] of texts) {
        const assetPath = join(assetsDir, name);
        const wroteAsset = await tryFsWrite("preview.writeFile", () => writeFile(assetPath, text, "utf8"), { path: assetPath });
        if (wroteAsset.isErr()) {
            return err({ kind: "fs", error: wroteAsset.error });
        }
    }
    const wrote = await tryFsWrite("preview.writeFile", () => writeFile(pagePath, args.page, "utf8"), { path: pagePath });
    if (wrote.isErr()) {
        return err({ kind: "fs", error: wrote.error });
    }

    const staged = new Set<string>([...reportFiles.keys(), ...texts.map(([name]) => name)]);
    await sweepAssets(assetsDir, staged, args.logger);
    return ok(pagePath);
}

/**
 * Remove each report-side file of the assets directory that this preview did not stage.
 *
 * The stage is authoritative: the root of the directory holds the closure of the page and nothing else. A
 * block that goes leaves a stale data asset, a stale sidecar, a stale figure, and the script of a derivation
 * that nothing binds. Each one costs disk and misleads a reader who opens the directory. The staged set is
 * what this run wrote, thus the sweep needs no read of the page.
 *
 * The `deps/` directory holds the shipped libraries and fonts. The manifest governs that set, and the stage
 * writes each entry of it on every run. Thus the sweep passes over the directory whole.
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
        if (entry === DEPS_DIR || staged.has(entry)) {
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
 * Mint the hosted view of the page that landed.
 *
 * An absent factory gives no grant, and the arm carries no access field — the page path stays the whole
 * local contract. The tool builds the publisher over the scope of the call, thus the mint runs under the
 * auth of the caller. A refusal, a thrown construction, and a thrown realization each become the
 * not-granted arm, thus a broken grant surface never costs the render. The URL spells through
 * `buildReportSessionUrl`, thus the formula lives in the contract and the seam gives the content-server
 * base alone.
 */
async function mintAccess(
    makeSessionPages: MakeSessionPagePublisher | undefined,
    analysisId: string,
    threadId: string,
    auth: AuthContext,
    logger: Logger,
): Promise<SessionPageAccess | undefined> {
    if (makeSessionPages === undefined) {
        return undefined;
    }
    let minted: SessionPageMintResult;
    try {
        minted = await makeSessionPages({ analysisId, auth }).mintSessionPageAccess(threadId);
    } catch (cause) {
        logger.warn("the session-page mint threw", { threadId, analysisId, ...defaultErrorFields(cause) });
        return { granted: false, detail: "session-page-access mint failed" };
    }
    if (!minted.ok) {
        logger.warn("the session-page mint refused", { threadId, analysisId, detail: describeSessionPageMintFailure(minted) });
        return { granted: false, detail: describeSessionPageMintFailure(minted) };
    }
    return {
        granted: true,
        url: buildReportSessionUrl(minted.data.baseUrl, analysisId, threadId, "index.html", minted.data.token),
        expiresAt: minted.data.expiresAt,
    };
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
            // reads them beside the cards and the value map is keyed by block. The chain carries the two
            // relative links of its entry, thus the renderer states them and it stages nothing.
            const used = referencedDerivations(document, derivations);
            const sessionDir = reportSessionDir(threadId);
            const rendered = renderReportPage(
                document,
                bridged.value,
                snapshot.citationRecords,
                used.map((record) => chainOf(record, sessionDir)),
            );
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
                scripts: scriptAssets(used),
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

            // The part rides the rendered arm only. Each degraded arm shows no
            // fresh page, thus it emits nothing.
            await ctx.emit({
                type: "data-report-rendered",
                data: { id: randomUUID(), renderedAt: new Date().toISOString(), title: document.title },
            });

            const access = await mintAccess(deps.makeSessionPages, analysisId, threadId, ctx.session.auth, logger);
            return ok({ outcome: "rendered", pagePath: written.value, ...(access !== undefined ? { access } : {}) });
        },
    });
}
