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
 * The card payload is built by the shared `buildFileReferenceCardData`, so the
 * live emit and the reconstruct-on-read path produce byte-identical cards.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { buildFileReferenceCardData, deriveRunId, fileGroupHash, MAX_FILES } from "../../memory/card-builders.js";
import { defineTool, type ToolError } from "../define-tool.js";
import { validatePath } from "../lib/path-validation.js";

type ShowFileOutput = { shown: false; reason: "invalid_path" } | { shown: true; id: string };

const ShowFileInputSchema = z.object({
    title: z.string().optional().describe("Group heading shown above the card or gallery"),
    files: z
        .array(
            z.object({
                path: z.string().describe("Analysis-rooted file path — no leading slash, no `..` (e.g., 'runs/run-abc/step-1/figures/volcano.png')"),
                caption: z.string().optional().describe("One-sentence context rendered beside this file"),
            }),
        )
        .min(1)
        .max(MAX_FILES)
        .describe(
            `The related set of files to show together, 1 to ${MAX_FILES} per call; multiple render as ONE gallery card. Pass a related set in a single call — do not make one call per figure.`,
        ),
});

export const showFileTool = defineTool({
    id: "show_file",
    description:
        "Display EXISTING analysis artifacts in chat by path — images, CSVs, PDFs, notebooks, logs. " +
        "The card references the file directly and its content is fetched when the user views it: you never read, " +
        "inline, or paste the bytes. Pick this tool by what you are referencing, not by how the output looks: " +
        "NOT for content you synthesized (a chart, a table, a snippet you invented — use `show_user`), NOT for a stored plan (`show_plan`). " +
        "Paths are analysis-rooted (no leading slash, no `..`); discover them with `workspace_search` or `list_files`. " +
        "Up to 10 files per call — pass a related set in ONE call and they render as a gallery, rather than one call per figure. " +
        "Cards render in call order, so to interleave figures with prose alternate `show_user(markdown)` and `show_file` calls " +
        "(markdown image syntax pointing at a workspace file does NOT render — this tool is the only way to show one).",
    inputSchema: ShowFileInputSchema,
    execute: async (input, ctx): Promise<Result<ShowFileOutput, ToolError>> => {
        const card = buildFileReferenceCardData(input);
        // A malformed/traversal path yields no card — an expected outcome the model can self-correct
        // (a data variant, not a thrown error). Zod already guarantees 1..MAX_FILES entries, so
        // `invalid_path` is the only reason the builder returns null here.
        if (card === null) {
            return ok({ shown: false as const, reason: "invalid_path" as const });
        }

        await ctx.emit({
            type: "data-file-reference",
            source: ctx.session.provenance,
            data: card,
        });

        return ok({ shown: true as const, id: card.id });
    },
});

/** Exposed for tests. */
export const __testing = { validatePath, deriveRunId, groupHash: fileGroupHash, MAX_FILES };
