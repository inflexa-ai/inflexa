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
 * absence, an unresolved reference, a bridge mismatch, a render problem, and a write failure. The tool
 * never throws for one of them. The filesystem speaks the throw protocol, thus the write runs inside a
 * guard that turns a fault into the ok-channel outcome.
 */

import { ok, type Result } from "neverthrow";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";

import type { Scope } from "../../auth/types.js";
import { isSafeId, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import type { Block, ReportDocument } from "../../contracts/report-blocks.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { defaultErrorFields, type Logger } from "../../lib/logger.js";
import { finishDraft, type FinishGap } from "../../report-model/draft-finish.js";
import type { ReferenceResolver, ReportSnapshot } from "../../report-model/reference-resolver.js";
import type { ResolutionFailure } from "../../report-model/validate.js";
import { bridgeValues, type BlockResolution, type BridgeMismatch, type ResolvedFile } from "../../report-render/value-bridge.js";
import { renderReportPage } from "../../report-render/render.js";
import type { RenderProblem } from "../../report-render/types.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import type { ReportSessionStateGateway, SessionRefusal } from "../report-authoring/authoring-tools.js";

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
 * The report thread and its analysis ride on the analysis scope. A scope of a different kind names neither.
 *
 * The thread id becomes one segment of the session directory below. Thus the safe-id check sits here, beside
 * the shape check, and not at the join: a scope whose id carries a separator or a traversal segment names no
 * thread that this tool can write under.
 */
function threadScopeOf(scope: Scope): { threadId: string; analysisId: string } | undefined {
    if (scope.kind !== "analysis" || scope.threadId === undefined || !isSafeId(scope.threadId)) {
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
            const scope = threadScopeOf(ctx.session.scope);
            if (scope === undefined) {
                const refusal: SessionRefusal = { reason: "no-thread-scope", detail: "the scope of the call names no usable report thread id" };
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

            const root = deps.resolveWorkspaceRoot(analysisId);
            const sessionDir = join(root, "report-sessions", threadId);
            const assetsDir = join(sessionDir, "assets");
            const pagePath = join(sessionDir, "index.html");
            try {
                await mkdir(sessionDir, { recursive: true });
                await stageFigures(resolutions, root, assetsDir);
                await writeFile(pagePath, rendered.value, "utf8");
            } catch (cause) {
                // A figure whose ledger path left the disk, a full volume, and a denied write each arrive as
                // a rejection of `node:fs`. The tool contract is ok-channel data for each degraded
                // condition, thus the fault becomes an outcome and the agent reads a cause instead of an
                // error tool result. The log keeps the full fault, because the outcome carries the message
                // alone.
                logger.warn("the page did not land", { threadId, ...defaultErrorFields(cause) });
                return ok({ outcome: "write-failed", detail: cause instanceof Error ? cause.message : String(cause) });
            }

            return ok({ outcome: "rendered", pagePath });
        },
    });
}
