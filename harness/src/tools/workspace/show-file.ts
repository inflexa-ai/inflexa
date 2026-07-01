/**
 * showFile tool — references existing analysis artifacts as a UI stream event.
 *
 * Emits a `data-file-reference` event carrying `{ title?, files: [{ path,
 * runId?, caption? }] }`. Cortex does not resolve file metadata — the UI
 * resolves `fileId`, `mimeType`, `size`, and presigned URLs against the
 * artifact service at render time.
 *
 * The `id` is derived deterministically from the file group, so an identical
 * re-emission carries the same id (downstream reconciliation handles dedup).
 */

import { createHash } from "node:crypto";

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";

type ShowFileOutput = { shown: false; reason: "invalid_path" } | { shown: true; id: string };

const MAX_FILES = 10;
const MAX_PATH_LEN = 1024;

/** Returns null for a legal analysis-rooted path, an error code otherwise. */
function validatePath(path: string): null | "invalid_path" {
    if (path.length === 0 || path.length > MAX_PATH_LEN) return "invalid_path";
    if (path.includes("\0")) return "invalid_path";
    if (path.startsWith("/")) return "invalid_path";
    for (const segment of path.split("/")) {
        if (segment === "..") return "invalid_path";
    }
    return null;
}

/** Extracts `runId` from paths shaped `runs/{runId}/...`; undefined otherwise. */
function deriveRunId(path: string): string | undefined {
    const segments = path.split("/");
    if (segments.length >= 2 && segments[0] === "runs" && segments[1]!.length > 0) {
        return segments[1];
    }
    return undefined;
}

/** Stable dedup key over sorted paths + optional title. */
function groupHash(paths: string[], title: string | undefined): string {
    const sorted = [...paths].sort();
    const material = JSON.stringify({ title: title ?? null, paths: sorted });
    return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

const ShowFileInputSchema = z.object({
    title: z.string().optional().describe("Group heading shown above the card or gallery"),
    files: z
        .array(
            z.object({
                path: z.string().describe("Analysis-rooted file path (e.g., 'runs/run-abc/step-1/figures/volcano.png')"),
                caption: z.string().optional().describe("One-sentence context rendered beside this file"),
            }),
        )
        .min(1)
        .max(MAX_FILES)
        .describe(`1 to ${MAX_FILES} files; multiple files render as a gallery`),
});

export const showFileTool = defineTool({
    id: "show_file",
    description:
        "Display one or more existing analysis artifacts (images, CSVs, PDFs, notebooks, logs) in chat by path. " +
        "Paths must be analysis-rooted (no leading slash, no `..`). Up to 10 files per call — multiple render as a gallery. " +
        "Do NOT read a file and paste its bytes elsewhere; this tool references the file directly. " +
        "File content is fetched when the user views the card — you do not need to provide it.",
    inputSchema: ShowFileInputSchema,
    execute: async (input, ctx): Promise<Result<ShowFileOutput, ToolError>> => {
        const { title, files } = input;

        for (const entry of files) {
            if (validatePath(entry.path) !== null) {
                // A malformed path is an expected outcome the model can self-correct
                // — a data variant, not a thrown error.
                return ok({ shown: false as const, reason: "invalid_path" as const });
            }
        }

        const id = `pres-${groupHash(
            files.map((f) => f.path),
            title,
        )}`;
        const entries = files.map((f) => {
            const runId = deriveRunId(f.path);
            return {
                path: f.path,
                ...(runId !== undefined ? { runId } : {}),
                ...(f.caption !== undefined ? { caption: f.caption } : {}),
            };
        });

        ctx.emit({
            type: "data-file-reference",
            source: ctx.session.provenance,
            data: { id, ...(title !== undefined ? { title } : {}), files: entries },
        });

        return ok({ shown: true as const, id });
    },
});

/** Exposed for tests. */
export const __testing = { validatePath, deriveRunId, groupHash, MAX_FILES };
