/**
 * findApprovalPrecedent — query openFDA / Drugs@FDA for prior approvals in a
 * given indication.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";

export const findApprovalPrecedentInputSchema = z.object({
    indication: z.string().min(1).describe("Indication / disease name — searched against openFDA label.indications_and_usage"),
    modality: z
        .enum(["small_molecule", "biologic", "gene_therapy", "cell_therapy"])
        .optional()
        .describe("Optional modality hint (advisory; not used for filtering today)"),
    mechanism: z.string().optional().describe("Optional MoA / mechanism hint (advisory; not used for filtering today)"),
});

interface Precedent {
    application_number: string;
    brand_name?: string;
    generic_name?: string;
    approval_date?: string;
    label_section_excerpts?: Record<string, string>;
}

interface OpenFdaLabelResult {
    openfda?: {
        application_number?: string[];
        brand_name?: string[];
        generic_name?: string[];
    };
    effective_time?: string;
    boxed_warning?: string[];
    warnings_and_precautions?: string[];
    warnings?: string[];
    contraindications?: string[];
}

const cache = new Map<string, { ts: number; value: { precedents: Precedent[] } }>();
const TTL_MS = 60 * 60 * 1000;

export const findApprovalPrecedent = defineTool({
    id: "find_approval_precedent",
    description:
        "Query openFDA / Drugs@FDA for prior approvals in a given indication. Returns NDA/BLA application numbers, generic and brand names, approval dates (effective time of the label), and label-section excerpts (boxed warning, warnings and precautions, contraindications). Use to ground class-precedent claims and disposition framing in the executive recommendation.",
    inputSchema: findApprovalPrecedentInputSchema,
    execute: async ({ indication, modality, mechanism }) => {
        const key = JSON.stringify({
            indication: indication.toLowerCase(),
            modality,
            mechanism,
        });
        const cached = cache.get(key);
        if (cached && Date.now() - cached.ts < TTL_MS) return ok(cached.value);

        const term = indication.replace(/"/g, "");
        const url = new URL("https://api.fda.gov/drug/label.json");
        url.searchParams.set("search", `indications_and_usage:"${term}"`);
        url.searchParams.set("limit", "10");

        const res = await fetch(url);
        // openFDA answers a zero-match search with 404 — an expected "no
        // precedents" outcome, not a failure. It is returned uncached so a
        // later, more specific query is not masked. Any other non-ok status
        // (5xx, 429) is an unexpected failure and throws.
        if (res.status === 404) return ok({ precedents: [] });
        if (!res.ok) {
            throw new Error(`openFDA label query failed: HTTP ${res.status}`);
        }

        const json = (await res.json()) as { results?: OpenFdaLabelResult[] };
        const precedents: Precedent[] = (json.results ?? []).slice(0, 10).map((r) => {
            const excerpts: Record<string, string> = {};
            if (r.boxed_warning?.[0]) excerpts.boxed_warning = r.boxed_warning[0].slice(0, 1000);
            if (r.warnings_and_precautions?.[0]) excerpts.warnings_and_precautions = r.warnings_and_precautions[0].slice(0, 1000);
            else if (r.warnings?.[0]) excerpts.warnings = r.warnings[0].slice(0, 1000);
            if (r.contraindications?.[0]) excerpts.contraindications = r.contraindications[0].slice(0, 1000);

            return {
                application_number: r.openfda?.application_number?.[0] ?? "(unknown)",
                brand_name: r.openfda?.brand_name?.[0],
                generic_name: r.openfda?.generic_name?.[0],
                approval_date: r.effective_time,
                label_section_excerpts: Object.keys(excerpts).length > 0 ? excerpts : undefined,
            };
        });

        const value = { precedents };
        cache.set(key, { ts: Date.now(), value });
        return ok(value);
    },
});

/** Test-only — clears the in-memory cache to avoid cross-test bleed. */
export function __resetApprovalPrecedentCacheForTest(): void {
    cache.clear();
}
