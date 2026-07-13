/**
 * Read-path reconstruction of display cards from a persisted turn.
 *
 * `show_plan` / `show_user` / `show_file` / `execute_plan` / `iterate_report` emit
 * `data-plan` / `data-presentation` / `data-file-reference` / `data-run-card` /
 * `data-report-preview` cards
 * live over the chat SSE stream. On reload, `content-to-cortex` calls this
 * resolver for each AI SDK tool-call part: a recognised display tool yields its card (rebuilt via the
 * shared `card-builders`); anything else yields `null` and falls back to a
 * generic `tool-call` chip. Keyed by the analysis `Pool` + id (plan / run) or
 * the analysis's workspace root (preview, filesystem-backed) so the card can
 * be re-loaded.
 */

import type { CortexPart } from "@inflexa-ai/harness/contracts/message.js";
import type { Pool } from "pg";

import { unwrapOrThrow } from "../lib/result.js";
import { validatePath } from "../tools/lib/path-validation.js";
import { buildFileReferenceCardData, buildPlanCardData, buildPresentationCardData, buildPreviewCardData, buildRunCardData } from "./card-builders.js";

export interface StoredToolCallForCard {
    readonly type: "tool_use";
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
}

export type ToolCardResolver = (block: StoredToolCallForCard) => Promise<CortexPart | null>;

export function createCardResolver(pool: Pool, analysisId: string, workspaceRoot: string): ToolCardResolver {
    return async (block) => {
        if (block.type !== "tool_use") return null;
        const input = (block.input ?? {}) as Record<string, unknown>;

        // The harness tool id is `iterate_report`; legacy transcripts carry
        // `iterateReport` — accept both.
        if (block.name === "iterate_report" || block.name === "iterateReport") {
            const report = (input.report ?? null) as { title?: unknown } | null;
            const card = await buildPreviewCardData(workspaceRoot, {
                previewId: typeof input.previewId === "string" ? input.previewId : undefined,
                title: report && typeof report.title === "string" ? report.title : undefined,
                format: input.format === "pdf" || input.format === "html" ? input.format : undefined,
            });
            return card ? ({ type: "data-report-preview", ...card } as CortexPart) : null;
        }

        if (block.name === "show_user") {
            // The live tool rejects a malformed/traversal echart `dataPath` and emits nothing; the
            // persisted tool_use still carries it, so the reload path MUST re-validate before building
            // the card — otherwise an unvalidated path is resurrected for the host to join into the
            // workspace root. Invalid → no card (chip fallback), matching the live "emitted nothing".
            if (typeof input.dataPath === "string" && validatePath(input.dataPath) !== null) return null;
            const card = buildPresentationCardData(input);
            return card ? ({ type: "data-presentation", ...card } as CortexPart) : null;
        }

        if (block.name === "show_file") {
            const card = buildFileReferenceCardData(input);
            return card ? ({ type: "data-file-reference", ...card } as CortexPart) : null;
        }

        if (block.name === "show_plan") {
            const planId = typeof input.planId === "string" ? input.planId : null;
            if (!planId) return null;
            const title = typeof input.title === "string" ? input.title : undefined;
            const card = unwrapOrThrow(await buildPlanCardData(pool, planId, analysisId, title));
            return card ? ({ type: "data-plan", ...card } as CortexPart) : null;
        }

        if (block.name === "execute_plan") {
            const planId = typeof input.planId === "string" ? input.planId : null;
            if (!planId) return null;
            const card = unwrapOrThrow(await buildRunCardData(pool, { planId, analysisId }));
            return card ? ({ type: "data-run-card", ...card } as CortexPart) : null;
        }

        return null;
    };
}
