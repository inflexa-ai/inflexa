/**
 * build_report tool — renders `report.html.j2` → `index.html` via the
 * in-process Nunjucks renderer. Closes over the runner's preview-dir state.
 *
 * Returns structured success or a typed error so the agent can fix and retry.
 * Version dir and templates dir are closure-state.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool } from "../define-tool.js";
import { renderReport } from "../../execution/report-render.js";

export interface BuildReportToolState {
    readonly versionDir: string;
    readonly templatesDir: string;
}

export function createBuildReportTool(state: BuildReportToolState): Tool {
    return defineTool({
        id: "build_report",
        description:
            "Render the report by compiling report.html.j2 into index.html. " +
            "Always use this — never invoke a build script directly. Returns " +
            "structured errors with line numbers when the template is broken.",
        inputSchema: z.object({}),
        execute: async () => {
            return ok(
                await renderReport({
                    versionDir: state.versionDir,
                    templatesDir: state.templatesDir,
                }),
            );
        },
    });
}
