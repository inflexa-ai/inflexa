/**
 * alphafoldPrediction — the AlphaFold DB predicted 3-D structure of one
 * UniProt accession.
 *
 * Returns model metadata, confidence, and artifact URLs only — never file
 * contents. A predicted `.pdb` or `.cif` file holds megabytes of coordinates
 * that give the model no benefit in a chat turn. A download of one belongs in
 * the sandbox, where a step can fetch a URL that this tool returns.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { fetchAlphaFoldPrediction, type AlphaFoldPrediction } from "../lib/alphafold-client.js";

export type AlphaFoldPredictionOutput = { readonly found: false; readonly uniprotAccession: string } | ({ readonly found: true } & AlphaFoldPrediction);

export const alphafoldPredictionTool = defineTool({
    id: "alphafold_prediction",
    description:
        "AlphaFold DB — the predicted 3-D protein structure of EMBL-EBI and DeepMind, keyed by a UniProt accession ('P38398'). Predicted confidence " +
        "(pLDDT), not experimental certainty: it tells apart a folded domain from a disordered loop, it does not replace a solved structure.\n" +
        "`globalMetricValue` is the mean pLDDT over the whole chain, and each `fractionPlddt*` is the fraction of residues in one band: above 90 is " +
        "very high, 70 to 90 is confident, 50 to 70 is low, and below 50 is very low or disordered. A LOW globalMetricValue is not a failed " +
        "prediction — BRCA1 scores about 41 because BRCA1 is largely disordered, and AlphaFold reports that correctly. Both values describe the whole " +
        "chain and neither locates a region: `plddtDocUrl` holds the per-residue pLDDT that does.\n" +
        "Returns URLs only (`pdbUrl`, `cifUrl`, `paeImageUrl`, `plddtDocUrl` — the per-residue confidence, `paeDocUrl` — the predicted aligned error " +
        "matrix, `amAnnotationsUrl` — AlphaMissense pathogenicity annotations, present for a HUMAN canonical accession only, thus absent on a " +
        "non-human protein and on an isoform): fetch one from the sandbox to inspect the coordinates, the per-residue confidence, or the annotation " +
        "table, do not expect the file contents here.\n" +
        'To SHOW the predicted structure to the user, call `show_user(kind: "structure", url: <pdbUrl or cifUrl>)` with the URL ' +
        "verbatim — the chat renders an interactive 3-D view colored by pLDDT. Do not download the file to show it.\n" +
        "found: false means AlphaFold holds no model for the accession (not every UniProt entry has one) — report it and continue, do not retry.",
    inputSchema: z.object({
        uniprotAccession: z.string().min(1).describe("A UniProt accession, for example 'P38398' (BRCA1) or 'P69905' (hemoglobin subunit alpha)."),
    }),
    describeCall: ({ uniprotAccession }) => uniprotAccession,
    execute: async ({ uniprotAccession }): Promise<Result<AlphaFoldPredictionOutput, ToolError>> => {
        // The client trims before it builds the URL, thus a miss echoes the same
        // accession that the request carried and not the padded argument.
        const accession = uniprotAccession.trim();
        const prediction = await fetchAlphaFoldPrediction(accession);
        if (!prediction) return ok({ found: false as const, uniprotAccession: accession });
        return ok({ found: true as const, ...prediction });
    },
});
