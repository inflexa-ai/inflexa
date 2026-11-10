/**
 * The cases of MDV preparation: a step delivers an asset that the MDV upload reads. The grade reads the files that the
 * step leaves: the asset, the README, and the report of the validator of the skill with no error. Run them with
 * `--exec docker`, because the validator runs on the asset.
 */

import type { DataProfileResult } from "@inflexa-ai/harness/contracts/data-profile.js";

import type { EvalCase, Trial } from "../lib/case.js";
import type { LockedPackage } from "../lib/sandbox.js";
import { cellsGenerator } from "./domain.js";
import { PYTHON_BASE, sandboxCase } from "./sandbox.js";

const LOCK: readonly LockedPackage[] = [...PYTHON_BASE, ...["anndata", "scanpy", "h5py"].map((name) => ({ name, version: "1.0.0", track: "python" as const }))];
const H5AD_STUB = "[binary HDF5 content of an AnnData file]\n";

function profile(summary: string, path: string, description: string, rows: number, cols: number, scientificName: string, taxonId: string): DataProfileResult {
    return {
        summary,
        files: [{ path, description, dataType: "single-cell-anndata", format: "H5AD", rows, cols }],
        profiledAt: "2026-11-10T08:00:00.000Z",
        domain: "transcriptomics",
        subtype: "single-cell",
        organism: { scientificName, taxonId, source: "metadata", confidence: "high" },
    };
}

/** The step leaves an asset, a README, and a validator report that has no error. */
function mdvReady(): EvalCase["grade"] {
    return (trial: Trial) => {
        const paths = Object.keys(trial.files ?? {});
        const asset = paths.find((path) => path.endsWith(".mdv.h5ad"));
        if (asset === undefined)
            return { pass: false, detail: `no .mdv.h5ad asset (files: ${paths.filter((p) => !p.startsWith("logs/")).join(", ") || "none"})` };
        if (!paths.some((path) => /readme/i.test(path))) return { pass: false, detail: "no README" };
        const reports = Object.entries(trial.files ?? {}).filter(([path, text]) => path.endsWith(".json") && /"ok"\s*:/.test(text));
        if (reports.length === 0) return { pass: false, detail: "no validator report" };
        const clean = reports.find(([, text]) => /"ok"\s*:\s*true/.test(text));
        return clean === undefined
            ? { pass: false, detail: `${reports[0]?.[0] ?? "the report"} has errors` }
            : { pass: true, detail: `${asset} validates (${clean[0]})` };
    };
}

export const mdvCases: readonly EvalCase[] = [
    sandboxCase({
        id: "mdv-asset-validated",
        set: "dev",
        source: "mdv-preparation skill: an asset is MDV-ready when the validator reports zero errors, with a README",
        step: {
            stepId: "T1S1",
            agent: "analyst",
            name: "PBMC viewer asset",
            question: "Prepare the PBMC dataset so that the team can explore it in MDV.",
            acceptance: ["An MDV-ready asset with readable cell labels", "A README that explains the columns"],
            profile: profile(
                "scRNA-seq of PBMCs from 6 donors, 1,800 cells, raw counts, annotated.",
                "data/inputs/f-sc/pbmc.h5ad",
                "AnnData: raw counts in .X; .obs holds donor, condition, and cell_type",
                1800,
                500,
                "Homo sapiens",
                "9606",
            ),
            goal: "Let the team explore the PBMC data in MDV.",
        },
        setup: {
            files: { "data/inputs/f-sc/pbmc.h5ad": H5AD_STUB },
            generate: cellsGenerator({
                path: "data/inputs/f-sc/pbmc.h5ad",
                replicate: "donor",
                replicates: ["D1", "D2", "D3", "D4", "D5", "D6"],
                condition: "condition",
                levels: ["lupus", "healthy"],
                typeColumn: "cell_type",
                types: ["CD14_monocyte", "CD16_monocyte", "CD4_T", "CD8_T", "NK", "B", "pDC", "cDC", "platelet", "Treg", "plasma"],
                target: "CD14_monocyte",
                perReplicate: 300,
                genes: 500,
            }),
            packages: LOCK,
        },
        maxSteps: 40,
        timeoutMs: 3_600_000,
        grade: mdvReady(),
    }),
    sandboxCase({
        id: "mdv-asset-validated-held-out",
        set: "held-out",
        source: "paraphrase of mdv-asset-validated: mouse cortex nuclei, a viewer for the lab",
        step: {
            stepId: "T1S1",
            agent: "analyst",
            name: "Cortex nuclei for the viewer",
            question: "Turn the cortex nuclei into something the lab can load into the Multi-Dimensional Viewer and browse.",
            acceptance: ["A file that MDV loads with no error", "A short guide to its columns"],
            profile: profile(
                "snRNA-seq of mouse prefrontal cortex, 8 animals, 2,000 nuclei, raw counts, annotated.",
                "data/inputs/f-sn/cortex.h5ad",
                "AnnData: raw counts in .X; .obs holds animal, group, and celltype",
                2000,
                500,
                "Mus musculus",
                "10090",
            ),
            goal: "Let the lab browse the cortex nuclei in MDV.",
        },
        setup: {
            files: { "data/inputs/f-sn/cortex.h5ad": H5AD_STUB },
            generate: cellsGenerator({
                path: "data/inputs/f-sn/cortex.h5ad",
                replicate: "animal",
                replicates: ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"],
                condition: "group",
                levels: ["stress", "control"],
                typeColumn: "celltype",
                types: ["Microglia", "Astrocyte", "Oligodendrocyte", "OPC", "ExN", "InN", "Endothelial", "Pericyte"],
                target: "Microglia",
                perReplicate: 250,
                genes: 500,
            }),
            packages: LOCK,
        },
        maxSteps: 40,
        timeoutMs: 3_600_000,
        grade: mdvReady(),
    }),
];
