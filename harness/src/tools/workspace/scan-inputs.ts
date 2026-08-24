/**
 * `scan_inputs` tool — re-run the deterministic input scan over a subtree.
 *
 * The data-profile body runs the scan once before the agent loop and injects the
 * manifest into the briefing, because the scan is always needed and its result does
 * not depend on agent judgement. This tool is the other half: an agent that disagrees
 * with the observed shapes, or wants a directory the injected manifest summarised, can
 * get the evidence to group differently.
 *
 * Dependency-bearing factory. The walk, the shape observation, and every
 * prefix-sufficient header readout run in-process over the workspace read seam; only a
 * footer-indexed container reaches into the sandbox (see `input-scan/enrich.ts`).
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { enrichShapes } from "../../input-scan/enrich.js";
import { renderInputScanManifest, scanInputTree } from "../../input-scan/scan.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { SandboxRef } from "../../sandbox/types.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import { defineTool, type ToolError } from "../define-tool.js";

export interface ScanInputsDeps {
    readonly workspaceFs: WorkspaceFilesystem;
    readonly analysisId: string;
    /** Omit to skip the container readouts; the prefix readouts run regardless. */
    readonly sandboxClient?: SandboxClient;
    readonly sandbox?: SandboxRef;
    readonly workflowId: string;
    readonly stepId: string;
    readonly nextFunctionId: () => string;
    readonly deadlineMs: () => number;
}

type ScanInputsOutput = {
    readonly path: string;
    readonly fileCount: number;
    readonly shapeCount: number;
    /** The rendered manifest — bounded whatever the subtree's size. */
    readonly manifest: string;
};

export function createScanInputsTool(deps: ScanInputsDeps) {
    return defineTool({
        id: "scan_inputs",
        description:
            "Scan a directory of input files and report what is OBSERVABLE about it: per-format counts, " +
            "the shapes its filenames form (sets of files whose names differ only at marked positions), " +
            "the distinct values each varying position takes, how those positions co-occur, value overlap " +
            "between shapes, and the files that share structure with nothing else. " +
            "Deterministic — no model, no per-file decoding — so it costs the same on three files as on three thousand. " +
            "Your briefing already carries a scan of the whole input tree; call this to look at a subtree more closely, " +
            "or to check a grouping you are unsure about. " +
            "It reports observations only: which files are one KIND of data, and what a varying position MEANS, are yours to decide.",
        inputSchema: z.object({
            path: z.string().min(1).describe("Directory to scan, relative to the analysis root (e.g. 'data/inputs' or 'data/inputs/vcf')."),
        }),
        describeCall: ({ path }) => path,
        execute: async ({ path }, ctx): Promise<Result<ScanInputsOutput, ToolError>> => {
            const scan = await scanInputTree({
                session: ctx.session,
                fs: deps.workspaceFs,
                root: path.replace(/^\/+/, "").replace(/\/+$/, ""),
                signal: ctx.signal,
            });

            const shapes = await enrichShapes({
                shapes: scan.manifest.shapes,
                session: ctx.session,
                fs: deps.workspaceFs,
                ...(deps.sandboxClient && deps.sandbox ? { sandboxClient: deps.sandboxClient, sandbox: deps.sandbox } : {}),
                mountRoot: `/${deps.analysisId}`,
                execId: `${deps.workflowId}:${deps.stepId}:${deps.nextFunctionId()}`,
                deadlineMs: deps.deadlineMs(),
                emit: ctx.emit,
            });

            const manifest = { ...scan.manifest, shapes };
            return ok({
                path: manifest.root,
                fileCount: manifest.fileCount,
                shapeCount: manifest.shapes.length,
                manifest: renderInputScanManifest(manifest),
            });
        },
    });
}
