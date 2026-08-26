/**
 * opentargets — one tool over the Open Targets Platform: target-disease
 * association evidence, read from a gene or from a disease.
 *
 * Curated safety liabilities are not served here: `target_safety` owns them,
 * because it pairs them with the local secondary-pharmacology panel and
 * resolves the Ensembl id they need.
 *
 * The input is a flat object with an `action` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs
 * a top-level `"type":"object"`). Each action's identifier is optional in the
 * schema and enforced by `.refine`, so a call that omits it fails at the loop
 * boundary with an actionable message instead of reaching the API.
 *
 * The identifier fields are deliberately separate (`ensemblId` / `efoId`)
 * rather than one polymorphic `query`: Open Targets accepts ONLY an Ensembl
 * gene ID or an EFO disease ID, and a gene symbol silently returns an empty
 * result rather than an error. Naming the two identifiers apart is what makes
 * that contract visible at the call site.
 *
 * `resolve_disease` closes that contract. It takes the plain disease name a
 * user supplies and returns the disease ids of the same corpus, thus the
 * caller never has to know an ontology id before it can ask a question.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import {
    searchDiseaseAssociations,
    searchDiseases,
    searchTargetAssociations,
    type Association,
    type DiseaseCandidate,
    type TargetInfo,
} from "../lib/opentargets-client.js";

const DEFAULT_LIMIT = 10;

const inputSchema = z
    .object({
        action: z
            .enum(["target", "disease", "resolve_disease"])
            .describe(
                "'target' (needs ensemblId) — the diseases associated with the gene: targetInfo (approvedSymbol, approvedName, " +
                    "tractability across small molecule / antibody / other modalities) plus associations[], each with an overall score and " +
                    "its per-datatype breakdown — genetic association, known drug, literature, animal model, somatic mutation. " +
                    "'disease' (needs efoId) — the targets ranked for that disease; each association carries targetId/targetSymbol/targetName " +
                    "and the same score breakdown. " +
                    "'resolve_disease' (needs diseaseName) — the disease-name resolver: a plain name ('type 2 diabetes', 'asthma') comes back as " +
                    "candidates[] { id, name, description }, best match first. Take the id of the row whose name you meant and pass it as efoId.",
            ),
        ensemblId: z.string().optional().describe("Ensembl gene ID, e.g. ENSG00000141510 (TP53). Required for action 'target'."),
        efoId: z
            .string()
            .optional()
            .describe(
                "Open Targets disease ID, e.g. EFO_0000311, MONDO_0005148 or HP_0001250. Required for action 'disease'. Get one from " +
                    "action 'resolve_disease', or from the diseaseId of an action 'target' association.",
            ),
        diseaseName: z
            .string()
            .min(1)
            .optional()
            .describe("Required for action 'resolve_disease'. A plain disease or trait name, e.g. 'type 2 diabetes'. No ontology id, no synonym list."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe(
                `Max associations to return (default ${DEFAULT_LIMIT}, max 100), ordered by DESCENDING association score. The default is the top ` +
                    `${DEFAULT_LIMIT}, which is where the evidence is; raise it only when you are surveying the long tail rather than ranking. ` +
                    "For action 'resolve_disease' it caps the candidate rows instead.",
            ),
    })
    .refine((d) => d.action !== "target" || (d.ensemblId !== undefined && d.ensemblId.trim().length > 0), {
        message:
            "ensemblId is required when action is 'target' — Open Targets accepts only Ensembl gene IDs (ENSG…), " +
            "never gene symbols. Resolve the symbol to an ENSG id with search_gene, then retry.",
        path: ["ensemblId"],
    })
    .refine((d) => d.action !== "disease" || (d.efoId !== undefined && d.efoId.trim().length > 0), {
        message:
            "efoId is required when action is 'disease' — Open Targets accepts only a disease ID (e.g. EFO_0000311), never a free-text disease name. " +
            "Call action='resolve_disease' with the name to get the ID, then retry.",
        path: ["efoId"],
    })
    .refine((d) => d.action !== "resolve_disease" || (d.diseaseName !== undefined && d.diseaseName.trim().length > 0), {
        message: "diseaseName is required when action is 'resolve_disease' — the plain disease or trait name to resolve.",
        path: ["diseaseName"],
    });

type OpenTargetsOutput =
    { targetInfo: TargetInfo | null; associations: Association[] } | { associations: Association[] } | { totalFound: number; candidates: DiseaseCandidate[] };

export const openTargetsTool = defineTool({
    id: "opentargets",
    description:
        "Query the Open Targets Platform — the integrated target-disease evidence corpus of EMBL-EBI, GSK and their partners — the preferred FIRST call " +
        "for target assessment, since one 'target' query yields the genetic evidence, tractability, and drug landscape together, already scored and " +
        "ranked. See the action parameter for what each mode needs and returns.\n" +
        "It is the integrated view; the underlying records live elsewhere. For the raw genetic evidence (individual SNPs from the GWAS Catalog, DisGeNET " +
        "GDA scores, ClinVar variant pathogenicity) use gene_disease_evidence. For this target's mechanism-based safety liabilities use target_safety.\n" +
        "ACCEPTED IDENTIFIERS: an Ensembl gene ID for action 'target' (ENSG00000141510); an Open Targets disease ID for action 'disease' — EFO " +
        "(EFO_0000311), MONDO (MONDO_0005148) or HP (HP_0001250), because Open Targets keys a disease on EFO and EFO imports the other two; and a plain " +
        "disease NAME for action 'resolve_disease' ('type 2 diabetes'), which is how you obtain that disease ID. A bare gene symbol is NOT accepted by " +
        "action 'target' and silently returns an empty result — resolve it to its ENSG id with search_gene first.\n" +
        "NO-DATA IS FINAL — do not retry the same id. Empty associations mean no evidence, or an id the platform does not hold. An empty candidates " +
        "list means the name matched no disease: rephrase it, do not invent an id.",
    inputSchema,
    describeCall: "none",
    execute: async (input): Promise<Result<OpenTargetsOutput, ToolError>> => {
        const limit = input.limit ?? DEFAULT_LIMIT;
        switch (input.action) {
            case "target": {
                const targetInfo = await searchTargetAssociations(input.ensemblId!, limit);
                return ok({ targetInfo, associations: targetInfo?.associations ?? [] });
            }
            case "disease": {
                const associations = await searchDiseaseAssociations(input.efoId!, limit);
                return ok({ associations });
            }
            case "resolve_disease": {
                const { total, candidates } = await searchDiseases(input.diseaseName!, limit);
                return ok({ totalFound: total, candidates });
            }
        }
    },
});
