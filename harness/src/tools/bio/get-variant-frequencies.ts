/**
 * getVariantFrequencies — the population allele frequencies of short variants in
 * gnomAD, the primary filter of rare-variant interpretation.
 *
 * The input is a batch, not one variant: gnomAD limits each IP to 30 requests a
 * minute, and a script that looks up a candidate list one call at a time spends
 * that budget fast. One call is one request of at most 25 variants.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { GNOMAD_DATASETS, GNOMAD_MAX_VARIANTS, getVariantFrequencies, isGnomadVariantId, type GnomadFrequencies } from "../lib/gnomad-client.js";

/** How many variant IDs a call detail names: three IDs and the dataset stay inside the emit-site cap. */
const VARIANTS_IN_DETAIL = 3;

const CallsetOutputSchema = z
    .object({
        ac: z.number().nullable(),
        an: z.number().nullable(),
        af: z.number().nullable(),
        populations: z.array(z.object({ id: z.string(), ac: z.number(), an: z.number(), af: z.number().nullable() })),
    })
    .nullable();

/** The ok value. A script reads it as data, thus the catalog of `run_script` shows this type. */
const outputSchema = z.object({
    dataset: z.string(),
    referenceGenome: z.enum(["GRCh38", "GRCh37"]),
    variants: z.array(
        z.object({
            query: z.string(),
            variantId: z.string(),
            rsids: z.array(z.string()),
            genome: CallsetOutputSchema,
            exome: CallsetOutputSchema,
        }),
    ),
    notFound: z.array(z.string()),
});

export const getVariantFrequenciesTool = defineTool({
    id: "get_variant_frequencies",
    description:
        "Population allele frequencies of short variants from gnomAD, the Genome Aggregation Database of the Broad Institute (Chen et al., Nature 2024) " +
        "— the primary filter of rare-variant interpretation: a variant that is more common in the population than its disease allows is unlikely to cause it.\n" +
        `INPUT: up to ${GNOMAD_MAX_VARIANTS} variant IDs, chrom-pos-ref-alt ('1-55051215-G-GA'; a 'chr' prefix and ':' separators also work), ` +
        "chromosomes 1-22, X and Y. An indel keeps the shared base, as in a VCF. Each alt allele of a multi-allelic site is its own ID. " +
        "The coordinates must be on the reference genome of the dataset: the gnomad_r4 and gnomad_r3 datasets are GRCh38, the gnomad_r2_1 datasets " +
        "and exac are GRCh37. An ID on the other genome comes back in notFound, not as an error — lift it over first.\n" +
        "Each found variant carries the `query` that it answers, the normalized `variantId`, the `rsids`, and two callsets, `genome` and `exome`, each " +
        "{ ac (allele count), an (allele number), af (allele frequency, null when an is 0), populations } or null when the dataset has no such callset or no call there " +
        "(gnomad_r3 holds genomes only, exac exomes only). The two callsets are different samples: report each one, and do not add them. " +
        "`populations` gives the genetic ancestry groups (afr, nfe, eas, …), each with af = ac / an (null when an is 0). " +
        "`notFound` lists each ID that the dataset does not hold: gnomAD saw no such allele, or the site has no coverage. It is not proof that " +
        "the frequency is 0.\n" +
        "`dataset` defaults to gnomad_r4. A subset dataset (non_ukb, non_cancer, non_neuro, non_topmed, controls) leaves one cohort out, and a variant that only that cohort carries is in notFound.\n" +
        "RATE LIMIT: gnomAD allows each IP 30 requests a minute. Put the variants of one dataset into one call, not one call for each variant.\n" +
        "notFound is valid no-data — report it and continue, do not retry unchanged.",
    inputSchema: z.object({
        variantIds: z
            .array(z.string().trim().refine(isGnomadVariantId, "a variant ID is chrom-pos-ref-alt on chromosome 1-22, X or Y, for example '1-55051215-G-GA'"))
            .min(1)
            .max(GNOMAD_MAX_VARIANTS)
            .describe(`Variant IDs, chrom-pos-ref-alt, max ${GNOMAD_MAX_VARIANTS} (e.g. ['1-55051215-G-GA']).`),
        dataset: z
            .enum(GNOMAD_DATASETS)
            .default("gnomad_r4")
            .describe("The gnomAD dataset. gnomad_r4* and gnomad_r3* take GRCh38 coordinates, gnomad_r2_1* and exac take GRCh37."),
    }),
    outputSchema,
    view: "none",
    // The variants are the call, and the dataset fixes the genome build of their coordinates.
    describeCall: ({ variantIds, dataset }) => {
        const shown = variantIds.slice(0, VARIANTS_IN_DETAIL).join(", ");
        return variantIds.length <= VARIANTS_IN_DETAIL ? `${dataset}: ${shown}` : `${dataset}: ${variantIds.length} variants: ${shown}, …`;
    },
    execute: async ({ variantIds, dataset }): Promise<Result<GnomadFrequencies, ToolError>> => ok(await getVariantFrequencies(variantIds, dataset)),
});
