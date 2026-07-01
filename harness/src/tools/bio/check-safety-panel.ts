/**
 * checkSafetyPanel — look up identifiers against the curated
 * secondary-pharmacology safety target panel.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { CHEMBL_RE, ORGAN_SYSTEMS, SafetyPanelFileSchema, UNIPROT_RE, type OrganSystem, type SafetyTarget } from "../../data/safety-panel-schema.js";
import panelData from "../../data/safety-panel.json" with { type: "json" };
import { defineTool } from "../define-tool.js";

const PANEL = SafetyPanelFileSchema.parse(panelData);

const BY_CHEMBL: Map<string, SafetyTarget> = new Map(PANEL.targets.map((t) => [t.chembl_id, t]));
const BY_GENE: Map<string, SafetyTarget> = new Map(PANEL.targets.map((t) => [t.gene_symbol, t]));
const BY_UNIPROT: Map<string, SafetyTarget> = new Map(PANEL.targets.map((t) => [t.uniprot, t]));

type IdentifierType = "chembl_id" | "gene_symbol" | "uniprot" | "auto";

function detectType(id: string): "chembl_id" | "gene_symbol" | "uniprot" {
    if (CHEMBL_RE.test(id)) return "chembl_id";
    if (UNIPROT_RE.test(id)) return "uniprot";
    return "gene_symbol";
}

function lookup(id: string, type: Exclude<IdentifierType, "auto">): SafetyTarget | null {
    switch (type) {
        case "chembl_id":
            return BY_CHEMBL.get(id) ?? null;
        case "gene_symbol":
            return BY_GENE.get(id.toUpperCase()) ?? null;
        case "uniprot":
            return BY_UNIPROT.get(id) ?? null;
    }
}

export const checkSafetyPanelTool = defineTool({
    id: "check_safety_panel",
    description:
        "Look up identifiers (ChEMBL ID, gene symbol, or UniProt accession) against the curated " +
        "secondary-pharmacology safety target panel. Returns organ system, severity, and clinical " +
        "consequence for each matched target. Use as a fast first-pass off-target liability check; " +
        "for comprehensive assessment also call get-target-safety and search-toxcast.",
    inputSchema: z.object({
        identifiers: z.array(z.string().min(1)).min(0).max(200).describe("0-200 identifiers (ChEMBL IDs, gene symbols, or UniProt accessions)."),
        identifier_type: z
            .enum(["chembl_id", "gene_symbol", "uniprot", "auto"])
            .default("auto")
            .describe("Identifier interpretation. 'auto' detects per-input."),
        filter_organ: z.enum(ORGAN_SYSTEMS).optional().describe("Restrict matches to this organ system."),
    }),
    execute: async ({ identifiers, identifier_type = "auto", filter_organ }) => {
        const matches = identifiers.map((input) => {
            const type = identifier_type === "auto" ? detectType(input) : identifier_type;
            let entry = lookup(input, type);
            if (entry && filter_organ && entry.organ_system !== filter_organ) {
                entry = null;
            }
            return { input, matched_entry: entry };
        });

        const bySeverity = { high: 0, medium: 0, low: 0 };
        const byOrgan: Partial<Record<OrganSystem, number>> = {};
        let matched = 0;
        for (const m of matches) {
            if (!m.matched_entry) continue;
            matched++;
            bySeverity[m.matched_entry.severity]++;
            const o = m.matched_entry.organ_system;
            byOrgan[o] = (byOrgan[o] ?? 0) + 1;
        }

        return ok({
            matches,
            summary: {
                total_input: identifiers.length,
                matched,
                by_severity: bySeverity,
                by_organ: byOrgan as Record<string, number>,
            },
            panel_version: PANEL.panel_version,
        });
    },
});
