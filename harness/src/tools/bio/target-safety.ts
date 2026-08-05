/**
 * targetSafety — target-level, mechanism-based safety liability from the two
 * sources that carry it: the curated secondary-pharmacology panel that ships
 * with the harness, and Open Targets' curated liabilities.
 *
 * Both sources are keyed on the same target and answer the same question, so
 * the pairing belongs in the tool rather than in prose a caller has to
 * remember: one call consults both and merges what they carry.
 *
 * Identifier resolution is the tool's job, not the caller's: Open Targets
 * accepts ONLY an Ensembl gene id, and it is taken from the panel entry when
 * there is one and resolved from the gene symbol when there is not.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { ORGAN_SYSTEMS, type OrganSystem } from "../../contracts/organ-system.js";
import { SEVERITIES, type Severity } from "../../contracts/severity.js";
import { CHEMBL_RE, SafetyPanelFileSchema, UNIPROT_RE, type SafetyTarget } from "../../data/safety-panel-schema.js";
import panelData from "../../data/safety-panel.json" with { type: "json" };
import { defineTool } from "../define-tool.js";
import { resolveSymbolToEnsemblId } from "../lib/ensembl-client.js";
import { getTargetSafetyLiabilities, type SafetyLiability } from "../lib/opentargets-client.js";

const PANEL = SafetyPanelFileSchema.parse(panelData);

const BY_CHEMBL: Map<string, SafetyTarget> = new Map(PANEL.targets.map((t) => [t.chembl_id, t]));
const BY_GENE: Map<string, SafetyTarget> = new Map(PANEL.targets.map((t) => [t.gene_symbol, t]));
const BY_UNIPROT: Map<string, SafetyTarget> = new Map(PANEL.targets.map((t) => [t.uniprot, t]));

const ENSG_RE = /^ENSG\d{11}$/;

/** Ordered weakest → strongest so `minSeverity` can be a numeric floor. */
const SEVERITY_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

const SOURCES = ["panel", "opentargets"] as const;
type Source = (typeof SOURCES)[number];

/** Identifiers the panel can be swept for free; Open Targets costs a request each. */
const MAX_PANEL_IDENTIFIERS = 200;
const MAX_OPENTARGETS_IDENTIFIERS = 25;
const DEFAULT_LIABILITY_LIMIT = 10;

type ConcreteType = "chembl_id" | "gene_symbol" | "uniprot" | "ensembl_id";

function detectType(id: string): ConcreteType {
    if (CHEMBL_RE.test(id)) return "chembl_id";
    if (ENSG_RE.test(id)) return "ensembl_id";
    if (UNIPROT_RE.test(id)) return "uniprot";
    return "gene_symbol";
}

function panelLookup(id: string, type: ConcreteType): SafetyTarget | null {
    switch (type) {
        case "chembl_id":
            return BY_CHEMBL.get(id) ?? null;
        case "gene_symbol":
            return BY_GENE.get(id.toUpperCase()) ?? null;
        case "uniprot":
            return BY_UNIPROT.get(id) ?? null;
        case "ensembl_id":
            return PANEL.targets.find((t) => t.ensembl_gene_id === id) ?? null;
    }
}

interface TargetRow {
    input: string;
    identifierType: ConcreteType;
    /** The Ensembl id Open Targets was queried with, when one could be obtained. */
    ensemblId?: string;
    panelEntry?: SafetyTarget | null;
    liabilities?: SafetyLiability[];
    /** Liabilities Open Targets held before `liabilityLimit` trimmed them. */
    liabilityCount?: number;
    /** Why the Open Targets half is absent for this identifier, when it is. */
    opentargetsNote?: string;
}

interface SourceOutcome {
    source: Source;
    status: "ok" | "no_data" | "unavailable";
    /** Identifiers this source returned something for. */
    matched: number;
    detail?: string;
}

const inputSchema = z
    .object({
        identifiers: z
            .array(z.string().min(1))
            .min(1)
            .max(MAX_PANEL_IDENTIFIERS)
            .describe(
                `Target identifiers, 1–${MAX_PANEL_IDENTIFIERS} — gene symbols, ChEMBL target IDs, UniProt accessions, or Ensembl gene IDs, mixed ` +
                    `freely. Capped at ${MAX_OPENTARGETS_IDENTIFIERS} when source 'opentargets' is included, since that source costs a request per target.`,
            ),
        identifierType: z
            .enum(["chembl_id", "gene_symbol", "uniprot", "ensembl_id", "auto"])
            .optional()
            .describe(
                "Default 'auto', detecting per input by shape (CHEMBL…, ENSG…, UniProt accession, else a gene symbol). Set it only to force one reading.",
            ),
        sources: z
            .array(z.enum(SOURCES))
            .min(1)
            .optional()
            .describe(
                "Default BOTH — the panel is a local lookup with no request cost, and they cover different ground. " +
                    "'panel': the curated secondary-pharmacology panel — a fast first-pass off-target screen giving organ system, severity and clinical " +
                    "consequence with references. Finite and hand-curated, so absence is NOT evidence of safety. " +
                    "'opentargets': curated target liabilities — event, affected biosamples, direction of effect, source. Needs an Ensembl gene id, taken " +
                    "from the panel entry or resolved from the symbol for you.",
            ),
        filterOrgan: z.enum(ORGAN_SYSTEMS).optional().describe("'panel' only. Keep only matches in this organ system, when screening one liability class."),
        minSeverity: z.enum(SEVERITIES).optional().describe("'panel' only. Drop matches below this severity; default 'low'. Use 'high' to triage a large set."),
        liabilityLimit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe(`'opentargets' only. Max liabilities per target (default ${DEFAULT_LIABILITY_LIMIT}, max 100); \`liabilityCount\` gives the true total.`),
    })
    .refine((d) => (d.sources ?? [...SOURCES]).includes("opentargets") === false || d.identifiers.length <= MAX_OPENTARGETS_IDENTIFIERS, {
        message:
            `identifiers is capped at ${MAX_OPENTARGETS_IDENTIFIERS} when source 'opentargets' is included (one request per target). ` +
            `Either narrow the list, or pass sources: ['panel'] to sweep up to ${MAX_PANEL_IDENTIFIERS} against the local panel first and follow up on the hits.`,
        path: ["identifiers"],
    });

export const targetSafetyTool = defineTool({
    id: "target_safety",
    description:
        "TARGET-level, mechanism-based safety liability — the curated secondary-pharmacology panel and Open Targets' curated liabilities in one call. " +
        "Judges what engaging a target is likely to do to an organ system, before any specific molecule exists. Identifiers may be gene symbols, ChEMBL " +
        "target IDs, UniProt accessions or Ensembl gene IDs, mixed.\n" +
        "This is the safety of the TARGET, not of a drug. For a marketed molecule's post-market adverse events use search_faers; for a chemical's " +
        "toxicology use comptox; for what removing the gene does in vivo use gene_preclinical_profile.\n" +
        "ABSENCE IS NOT SAFETY. The panel is finite and hand-curated, so no match means only 'not on the panel'; an empty Open Targets liability list " +
        "means no CURATED liability, not that none exists. Both are valid no-data — do not retry. Read `perSource` and each row's `opentargetsNote`: a " +
        "ChEMBL or UniProt identifier absent from the panel cannot be resolved to an Ensembl id, so its Open Targets half is skipped rather than empty.",
    inputSchema,
    describeCall: "none",
    execute: async ({ identifiers, identifierType, sources, filterOrgan, minSeverity, liabilityLimit }) => {
        const selected = sources ?? [...SOURCES];
        const wantPanel = selected.includes("panel");
        const wantOpenTargets = selected.includes("opentargets");
        const severityFloor = SEVERITY_ORDER[minSeverity ?? "low"];
        const limit = liabilityLimit ?? DEFAULT_LIABILITY_LIMIT;

        const rows: TargetRow[] = identifiers.map((input) => {
            const type = identifierType && identifierType !== "auto" ? identifierType : detectType(input);
            const row: TargetRow = { input, identifierType: type };

            if (wantPanel) {
                const entry = panelLookup(input, type);
                const organMatches = !entry || !filterOrgan || entry.organ_system === filterOrgan;
                const severityMatches = !entry || SEVERITY_ORDER[entry.severity] >= severityFloor;
                row.panelEntry = entry && organMatches && severityMatches ? entry : null;
            }
            return row;
        });

        let opentargetsError: string | undefined;

        if (wantOpenTargets) {
            await Promise.all(
                rows.map(async (row) => {
                    // Open Targets takes an ENSG only. The panel entry carries one for
                    // free; a gene symbol can be resolved; a ChEMBL or UniProt id that
                    // is not on the panel cannot, and is skipped explicitly.
                    const panelEnsembl = panelLookup(row.input, row.identifierType)?.ensembl_gene_id;
                    let ensemblId: string | null = row.identifierType === "ensembl_id" ? row.input : (panelEnsembl ?? null);

                    if (!ensemblId && row.identifierType === "gene_symbol") {
                        ensemblId = await resolveSymbolToEnsemblId(row.input);
                        if (!ensemblId) {
                            row.opentargetsNote = "gene symbol did not resolve to an Ensembl gene id";
                            return;
                        }
                    }
                    if (!ensemblId) {
                        row.opentargetsNote = `no Ensembl gene id available for a ${row.identifierType} that is not on the panel`;
                        return;
                    }

                    row.ensemblId = ensemblId;
                    try {
                        const result = await getTargetSafetyLiabilities(ensemblId);
                        if (!result) {
                            row.opentargetsNote = "no Open Targets record for this Ensembl gene id";
                            return;
                        }
                        row.liabilityCount = result.safetyLiabilities.length;
                        row.liabilities = result.safetyLiabilities.slice(0, limit);
                    } catch (error) {
                        opentargetsError = error instanceof Error ? error.message : String(error);
                        row.opentargetsNote = "Open Targets could not be reached";
                    }
                }),
            );
        }

        const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
        const byOrgan: Partial<Record<OrganSystem, number>> = {};
        let panelMatched = 0;
        for (const row of rows) {
            if (!row.panelEntry) continue;
            panelMatched++;
            bySeverity[row.panelEntry.severity]++;
            byOrgan[row.panelEntry.organ_system] = (byOrgan[row.panelEntry.organ_system] ?? 0) + 1;
        }
        const withLiabilities = rows.filter((r) => (r.liabilities?.length ?? 0) > 0).length;

        const perSource: SourceOutcome[] = [];
        if (wantPanel) {
            perSource.push({ source: "panel", status: panelMatched > 0 ? "ok" : "no_data", matched: panelMatched });
        }
        if (wantOpenTargets) {
            perSource.push({
                source: "opentargets",
                status: opentargetsError ? "unavailable" : withLiabilities > 0 ? "ok" : "no_data",
                matched: withLiabilities,
                ...(opentargetsError ? { detail: opentargetsError } : {}),
            });
        }

        return ok({
            perSource,
            summary: {
                totalInput: identifiers.length,
                panelMatched,
                bySeverity,
                byOrgan: byOrgan as Record<string, number>,
                openTargetsWithLiabilities: withLiabilities,
            },
            targets: rows,
            panelVersion: PANEL.panel_version,
        });
    },
});
