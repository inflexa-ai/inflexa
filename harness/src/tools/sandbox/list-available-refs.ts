/**
 * listAvailableRefs — list reference data available in the sandbox.
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";

const REFS_ROOT = "/mnt/refs";
const REGISTRY_FILE = join(REFS_ROOT, "registry.json");

interface RegistryEntry {
    local_path: string;
    sha256: string;
    bytes: number;
    rows: number | null;
    category: string | null;
    subtype: string | null;
    organism: string | null;
    tax_id: string | null;
    dataset: string | null;
    endpoint: string | null;
}

interface Registry {
    registry_version: string;
    build_id: string;
    generated_at: string;
    files: {
        by_category: Record<string, RegistryEntry[]>;
    };
    summary: {
        total_output_files: number;
        categories: string[];
    };
}

function formatCategory(category: string, entries: RegistryEntry[]): string {
    const labels: Record<string, string> = {
        atlas_singlecell:
            "Single-cell reference atlases for label transfer (Pan-Cancer T cell — " +
            "Zheng 2021, Pan-Cancer Myeloid — Cheng 2021, Tumor Immune Cell Atlas — " +
            "Nieto 2021, Tabula Sapiens v2). Available as .h5ad (Python: anndata, " +
            "scanpy, scvi-tools, symphonypy) and/or .rds (R: Seurat, ProjecTILs). " +
            "Tabula Sapiens ships full + immune_subset variants. " +
            "Use these for label transfer BEFORE falling back to marker genes.",
        atlas_azimuth:
            "Azimuth references (Seurat-native): PBMC v1.0.0 and Tonsil v1.0.0. " +
            "Each entry is a (ref.Rds, idx.annoy) pair stored under " +
            "/mnt/refs/atlas_azimuth/{pbmc,tonsil}/. Load with " +
            "Azimuth::LoadReference(path) where path is the directory containing " +
            "ref.Rds + idx.annoy (e.g. '/mnt/refs/atlas_azimuth/pbmc'), then " +
            "Azimuth::RunAzimuth(query, reference = path).",
        atlas_projectils:
            "ProjecTILs reference atlases (Seurat .rds): human + mouse, CD8 + CD4. " +
            "Use ProjecTILs::ProjecTILs.classifier() to assign every CD8 to one of " +
            "the canonical TCF7+/GZMK+/TEX/TPEX/MAIT substates without re-deriving " +
            "the classifier from scratch.",
        celltypist_models:
            "Pre-staged CellTypist .pkl classifier models (Immune_All_Low backed by " +
            "the Cross-Tissue Immune Cell Atlas; Immune_All_High; Pan_Fetal_Human; " +
            "COVID19_Immune_Landscape). CELLTYPIST_FOLDER env var is preset, so " +
            "celltypist.annotate_cells(model='Immune_All_Low') resolves with no " +
            "network call.",
        marker_panels:
            "Marker gene panels: PanglaoDB (community, parquet long-format), " +
            "CellMarker 2.0 (tumor-context, parquet long-format), and the Cortex " +
            "hand-curated panel for Stage 1 substates (TCF7+ memory CD8, exhausted " +
            "CD8, effector-memory CD8, proliferating T, cDC1/cDC2/LAMP3+ DC, SPP1+ " +
            "TAM, C1Q+ TAM, Tregs) — JSON with full provenance.",
        gene_signatures:
            "Curated gene signatures from key tumor-immune papers: Sade-Feldman " +
            "2018 exhausted CD8 (Table S2), Jerby-Arnon 2018 malignant resistance " +
            "program (Table S1, Stage 3 classifier substrate), Tirosh 2016 AXL/MITF " +
            "programs, Puram 2017 p-EMT (Table S5, HNSCC), Reactome cGAS-STING " +
            "pathway (Stage 2.3 type-I IFN). JSON with PMID/DOI per entry.",
        normal_reference:
            "Normal-tissue references for safety firing checks: GTEx v8 per-tissue " +
            "median TPM (parquet) + sample attributes (parquet). Use to quantify " +
            "off-target activation of any nominated classifier across healthy tissues.",
        gene_mappings:
            "Gene ID Conversion Tables: Entrez/Ensembl/RefSeq/UniProt to symbol (NCBI); " +
            "orthologs (Ensembl Compara) — file: orthologs_{tax_id}.parquet, columns: " +
            "tax_id, ensembl_gene_id, entrez_id, symbol, relationship, other_tax_id, " +
            "other_ensembl_gene_id, other_entrez_id, other_symbol; symmetric — to find " +
            "human orthologs of Macaca fascicularis genes, open orthologs_9541.parquet " +
            "and filter other_tax_id == '9606'; cross-division (e.g. yeast↔mouse) " +
            "requires pivoting through human: yeast→human via orthologs_4896.parquet, " +
            "then human→mouse via orthologs_9606.parquet",
        omnipath: "OmniPath (interactions, regulons, annotations)",
        reactome: "Reactome Pathways",
        progeny: "PROGENy Pathway Weights (decoupler: source/target/weight/padj)",
        collectri: "CollecTRI TF-Target Regulons (decoupler: source/target/mor)",
        dorothea: "DoRothEA TF Regulons (decoupler: source/target/weight/confidence)",
        lincs: "LINCS L1000 Drug Perturbation Consensus Signatures (up/down gene sets)",
        hpa: "Human Protein Atlas (tissue RNA expression, target safety/secretome, full 107-column atlas)",
        wikipathways: "WikiPathways Gene Sets",
        msigdb: "MSigDB Gene Set Collections",
        safety_targets: "Curated Off-Target Safety Panel (CSV + JSON: chembl_id, gene_symbol, uniprot, organ_system, severity, clinical_consequence)",
    };

    const lines: string[] = [`\n## ${labels[category] ?? category}`];

    const grouped = new Map<string, RegistryEntry[]>();
    for (const e of entries) {
        const key = e.organism ?? e.tax_id ?? e.subtype ?? "general";
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(e);
    }

    for (const [group, items] of grouped) {
        if (grouped.size > 1) lines.push(`\n### ${group}`);
        for (const e of items) {
            const path = join(REFS_ROOT, e.local_path);
            const name = basename(e.local_path);
            const info = [e.rows != null ? `${e.rows.toLocaleString()} rows` : null, e.subtype, e.dataset].filter(Boolean).join(", ");
            lines.push(`  ${name}: ${path}${info ? `  (${info})` : ""}`);
        }
    }
    return lines.join("\n");
}

export const listAvailableRefsTool = defineTool({
    id: "list_available_refs",
    description:
        "List all reference data available in the sandbox: single-cell atlases for " +
        "label transfer (Pan-Cancer T/Myeloid, TICA, Tabula Sapiens, Azimuth PBMC/Tonsil), " +
        "ProjecTILs CD8/CD4 atlases, CellTypist models, marker panels (PanglaoDB, " +
        "CellMarker 2.0, Cortex curated), gene signatures (Sade-Feldman, Jerby-Arnon, " +
        "Tirosh, Puram, cGAS-STING), normal-tissue references (GTEx v8), gene mappings, " +
        "UniProt, OmniPath networks, Reactome, PROGENy, CollecTRI, DoRothEA, " +
        "WikiPathways, MSigDB, LINCS L1000, HPA, and the curated off-target safety " +
        "panel. Returns file paths for h5ad/rds/pkl/parquet/GMT/CSV/JSON resources. " +
        "No data can be downloaded at runtime — only what this tool returns is available.",
    inputSchema: z.object({}),
    execute: async () => {
        // A missing reference-store mount is an expected environment state —
        // model it as an `available: false` data variant with a fallback note.
        try {
            const raw = await readFile(REGISTRY_FILE, "utf-8");
            const registry: Registry = JSON.parse(raw);

            const header = [
                `Reference Store (build ${registry.build_id}, ${registry.generated_at})`,
                `Total files: ${registry.summary.total_output_files}`,
                `Mount: ${REFS_ROOT}`,
            ].join("\n");

            const categoryOrder = [
                "atlas_singlecell",
                "atlas_azimuth",
                "atlas_projectils",
                "celltypist_models",
                "marker_panels",
                "gene_signatures",
                "normal_reference",
                "safety_targets",
                "progeny",
                "collectri",
                "dorothea",
                "omnipath",
                "lincs",
                "msigdb",
                "wikipathways",
                "reactome",
                "hpa",
                "gene_mappings",
            ];

            const known = new Set(categoryOrder);
            const allCategories = [
                ...categoryOrder.filter((c) => registry.files.by_category[c]),
                ...Object.keys(registry.files.by_category).filter((c) => !known.has(c)),
            ];

            const sections = allCategories.map((c) => formatCategory(c, registry.files.by_category[c]!));

            return ok({ available: true, content: header + "\n" + sections.join("\n") });
        } catch {
            return ok({
                available: false,
                content:
                    "Reference store not available. The reference store may not be mounted at /mnt/refs. " +
                    "Gene mappings, UniProt, OmniPath, Reactome, PROGENy, CollecTRI, DoRothEA, " +
                    "WikiPathways, MSigDB, LINCS L1000, HPA, and the curated off-target safety panel " +
                    "cannot be loaded from pre-staged files.",
            });
        }
    },
});
