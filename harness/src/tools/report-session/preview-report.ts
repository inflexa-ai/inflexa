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
 * Each degraded condition is a typed outcome in the ok channel: a session refusal, a gap list, a resolver
 * absence, an unresolved reference, a bridge mismatch, and a render problem. The tool never throws for one
 * of them. When a `PreviewPublisher` realization mints access, the result also carries the minted access.
 * When the mint fails, the result names the absence, and the page path still returns.
 */

import { ok, type Result } from "neverthrow";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";

import type { Scope } from "../../auth/types.js";
import type { Block, ReportDocument } from "../../contracts/report-blocks.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { finishDraft, type FinishGap } from "../../report-model/draft-finish.js";
import type { ReferenceResolver, ReportSnapshot } from "../../report-model/reference-resolver.js";
import type { ResolutionFailure } from "../../report-model/validate.js";
import { bridgeValues, type BlockResolution, type BridgeMismatch, type ResolvedFile } from "../../report-render/value-bridge.js";
import { renderReportPage } from "../../report-render/render.js";
import type { RenderProblem } from "../../report-render/types.js";
import { describeMintFailure, type PreviewPublisher } from "../report/preview-publisher.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import type { ReportSessionStateGateway, SessionRefusal } from "../report-authoring/authoring-tools.js";

/** The empty input. The tool renders the current draft of the thread, thus it needs no field. */
const previewReportInput = z.object({});

export type PreviewReportInput = z.infer<typeof previewReportInput>;

/**
 * The hosted access of a preview. `minted: true` carries the surface that the publisher gave. `minted:
 * false` names the absence, and the page path still returns beside it.
 */
export type PreviewAccess = { minted: true; baseUrl: string; token: string; expiresAt: string } | { minted: false; detail: string };

/**
 * The typed outcome of the preview tool. Each arm is ok-channel data, thus the tool never throws for a
 * degraded condition. `rendered` carries the absolute page path and the hosted access.
 */
export type PreviewReportResult =
    | { outcome: "refused"; refusal: SessionRefusal }
    | { outcome: "gaps"; gaps: FinishGap[] }
    | { outcome: "resolver-unavailable" }
    | { outcome: "unresolved-references"; unresolved: ResolutionFailure[] }
    | { outcome: "bridge-mismatch"; mismatches: BridgeMismatch[] }
    | { outcome: "render-problems"; problems: RenderProblem[] }
    | { outcome: "rendered"; pagePath: string; access: PreviewAccess };

/**
 * The construction deps of the preview tool.
 *
 * `root` is a resolved absolute path, and the tool never resolves a root itself. `resolver` is optional,
 * because a resolver realization can be absent. `previews` mints hosted access only, and it carries no
 * page.
 */
export interface PreviewReportToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly resolver?: ReferenceResolver;
    readonly previews: PreviewPublisher;
    readonly root: string;
    readonly logger?: Logger;
}

/** The report thread and its analysis ride on the analysis scope. A scope of a different kind names neither. */
function threadScopeOf(scope: Scope): { threadId: string; analysisId: string } | undefined {
    if (scope.kind !== "analysis" || scope.threadId === undefined) {
        return undefined;
    }
    return { threadId: scope.threadId, analysisId: scope.analysisId };
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
 * Resolve the references of one block, and give back the resolution of the block.
 *
 * A value-bearing kind carries its resolved value for the bridge. A no-value kind carries none. A section
 * gives its own resolution and the resolutions of its children in document order. An unresolved reference
 * lands in `unresolved` with the id of the block that carries it.
 *
 * The switch is exhaustive over the block kinds. A ninth kind reaches the end with no return, and the
 * declared return type fails the build. Thus the walk cannot drop a kind in silence.
 */
async function resolveBlock(block: Block, resolver: ReferenceResolver, snapshot: ReportSnapshot, unresolved: ResolutionFailure[]): Promise<BlockResolution[]> {
    switch (block.kind) {
        case "text":
            return [{ blockId: block.id, kind: "text" }];
        case "claim": {
            for (const binding of block.bindings) {
                const resolved = await resolver.resolve(binding, snapshot);
                if (resolved.isErr()) {
                    unresolved.push({ blockId: block.id, failure: resolved.error });
                }
            }
            return [{ blockId: block.id, kind: "claim" }];
        }
        case "citation": {
            const resolved = await resolver.resolve(block.binding, snapshot);
            if (resolved.isErr()) {
                unresolved.push({ blockId: block.id, failure: resolved.error });
            }
            return [{ blockId: block.id, kind: "citation" }];
        }
        case "metric": {
            const resolved = await resolver.resolve(block.value, snapshot);
            if (resolved.isErr()) {
                unresolved.push({ blockId: block.id, failure: resolved.error });
                return [];
            }
            return [{ blockId: block.id, kind: "metric", resolved: resolved.value }];
        }
        case "table": {
            const resolved = await resolver.resolve(block.binding, snapshot);
            if (resolved.isErr()) {
                unresolved.push({ blockId: block.id, failure: resolved.error });
                return [];
            }
            return [{ blockId: block.id, kind: "table", resolved: resolved.value }];
        }
        case "chart": {
            const resolved = await resolver.resolve(block.binding, snapshot);
            if (resolved.isErr()) {
                unresolved.push({ blockId: block.id, failure: resolved.error });
                return [];
            }
            return [{ blockId: block.id, kind: "chart", resolved: resolved.value }];
        }
        case "figure": {
            const resolved = await resolver.resolve(block.binding, snapshot);
            if (resolved.isErr()) {
                unresolved.push({ blockId: block.id, failure: resolved.error });
                return [];
            }
            return [{ blockId: block.id, kind: "figure", resolved: resolved.value }];
        }
        case "section": {
            const resolutions: BlockResolution[] = [{ blockId: block.id, kind: "section" }];
            for (const child of block.blocks) {
                resolutions.push(...(await resolveBlock(child, resolver, snapshot, unresolved)));
            }
            return resolutions;
        }
    }
}

/** Walk the document, resolve each reference, and collect the resolutions and the unresolved references. */
async function resolveDocument(
    document: ReportDocument,
    resolver: ReferenceResolver,
    snapshot: ReportSnapshot,
): Promise<{ resolutions: BlockResolution[]; unresolved: ResolutionFailure[] }> {
    const resolutions: BlockResolution[] = [];
    const unresolved: ResolutionFailure[] = [];
    for (const section of document.sections) {
        resolutions.push(...(await resolveBlock(section, resolver, snapshot, unresolved)));
    }
    return { resolutions, unresolved };
}

/**
 * Stage each bound image beside the page.
 *
 * The staged name comes from `assetFileName`, thus a copy and the figure source agree on the file. A
 * duplicate name is one file for two figures, thus the copy runs one time for it. The source path of the
 * artifact is relative to the workspace root.
 */
async function stageFigures(resolutions: readonly BlockResolution[], root: string, assetsDir: string): Promise<void> {
    const files: ResolvedFile[] = [];
    for (const resolution of resolutions) {
        if (resolution.kind === "figure" && resolution.resolved.type === "file") {
            files.push(resolution.resolved);
        }
    }
    if (files.length === 0) {
        return;
    }
    await mkdir(assetsDir, { recursive: true });
    const staged = new Set<string>();
    for (const file of files) {
        const name = assetFileName(file);
        if (staged.has(name)) {
            continue;
        }
        staged.add(name);
        await copyFile(join(root, file.path), join(assetsDir, name));
    }
}

/**
 * Make the render-and-preview tool over the session-state gateway and the render seams.
 *
 * The tool reads the thread id from the scope of the call, and it loads the state through the gateway. Thus
 * one factory serves every thread. The tool holds no per-session value, and it resolves no root.
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
            const scope = threadScopeOf(ctx.session.scope);
            if (scope === undefined) {
                const refusal: SessionRefusal = { reason: "no-thread-scope", detail: "the scope of the call carries no report thread id" };
                return ok({ outcome: "refused", refusal });
            }
            const { threadId, analysisId } = scope;

            const loaded = await deps.gateway.load(threadId);
            if (loaded.outcome === "absent") {
                const refusal: SessionRefusal = { reason: "absent-state", detail: `no report session state exists for the thread ${threadId}` };
                return ok({ outcome: "refused", refusal });
            }
            if (loaded.outcome === "failed") {
                const refusal: SessionRefusal = { reason: "state-unavailable", detail: loaded.detail };
                return ok({ outcome: "refused", refusal });
            }
            const { document: draft, snapshot } = loaded.state;

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

            const sessionDir = join(deps.root, "report-sessions", threadId);
            const assetsDir = join(sessionDir, "assets");
            const pagePath = join(sessionDir, "index.html");
            await mkdir(sessionDir, { recursive: true });
            await stageFigures(resolutions, deps.root, assetsDir);
            await writeFile(pagePath, rendered.value, "utf8");

            const mint = await deps.previews.mintPreviewAccess(analysisId, threadId);
            if (!mint.ok) {
                const detail = describeMintFailure(mint);
                logger.warn("preview access unavailable — the page is on disk but no hosted surface exists", {
                    threadId,
                    ...(mint.status !== undefined ? { status: mint.status } : {}),
                });
                return ok({ outcome: "rendered", pagePath, access: { minted: false, detail } });
            }
            return ok({
                outcome: "rendered",
                pagePath,
                access: { minted: true, baseUrl: mint.data.baseUrl, token: mint.data.token, expiresAt: mint.data.expiresAt },
            });
        },
    });
}
