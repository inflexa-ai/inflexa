/**
 * Pure async client functions for the GraphQL API of gnomAD, the Genome
 * Aggregation Database of the Broad Institute (Chen et al., Nature 2024): the
 * allele count, number and frequency of a short variant in the genome callset
 * and in the exome callset of one dataset.
 *
 * Absence policy: a GraphQL server answers an explicit `null` for a nullable
 * field, and it never omits the key. Thus each nullable field of the gnomAD
 * schema carries `.nullable()`, not `.optional()`: a callset that the dataset
 * does not hold (the exomes of gnomAD v3, the genomes of ExAC), the counts of a
 * callset, the rsIDs, and the population list.
 *
 * A miss is no HTTP error. gnomAD answers HTTP 200, a `null` variant, and an
 * `errors` entry "Variant not found". gnomAD strips each error to its message,
 * with no `path`, thus a batch cannot tie an entry to its variant. The client
 * ties a miss to its variant through the `null` alias, and it throws on each
 * other message. The input pattern is stricter than the parser of gnomAD, thus
 * "Invalid variant ID" does not arrive for a valid input.
 *
 * Rate limit: gnomAD limits each IP to 30 requests and a query cost of 300 in
 * one minute, and one query to a cost of 25. One `variant` field costs 1. Thus
 * one request carries a batch of at most 25 variants, and the client sends one
 * gnomAD request at a time.
 */

import { z } from "zod";

import { withHost } from "../../lib/host-concurrency.js";
import { apiFetchValidated, describeApiError } from "./api-utils.js";

const GNOMAD_API = "https://gnomad.broadinstitute.org/api";

/** The datasets of the `DatasetId` enum of gnomAD. A subset dataset leaves one cohort out of its parent. */
export const GNOMAD_DATASETS = [
    "gnomad_r4",
    "gnomad_r4_non_ukb",
    "gnomad_r3",
    "gnomad_r3_controls_and_biobanks",
    "gnomad_r3_non_cancer",
    "gnomad_r3_non_neuro",
    "gnomad_r3_non_topmed",
    "gnomad_r3_non_v2",
    "gnomad_r2_1",
    "gnomad_r2_1_controls",
    "gnomad_r2_1_non_neuro",
    "gnomad_r2_1_non_cancer",
    "gnomad_r2_1_non_topmed",
    "exac",
] as const;

export type GnomadDataset = (typeof GNOMAD_DATASETS)[number];

export type ReferenceGenome = "GRCh38" | "GRCh37";

/** The reference genome of the coordinates of a dataset. A variant ID on the other genome is a miss, not an error. */
export function referenceGenomeOf(dataset: GnomadDataset): ReferenceGenome {
    return dataset.startsWith("gnomad_r2_1") || dataset === "exac" ? "GRCh37" : "GRCh38";
}

/** The most variants that one request carries: gnomAD refuses a query that costs more than 25, and each variant costs 1. */
export const GNOMAD_MAX_VARIANTS = 25;

const CHROMOSOMES: ReadonlySet<string> = new Set([...Array.from({ length: 22 }, (_, i) => String(i + 1)), "X", "Y"]);

function isAllele(allele: string): boolean {
    if (allele === "") return false;
    for (const base of allele) if (!"ACGT".includes(base)) return false;
    return true;
}

/**
 * Is a string a variant ID in the form chrom-pos-ref-alt, with an optional `chr` and with `-` or `:` between the
 * parts? The chromosome is 1 to 22, X, or Y: gnomAD serves a mitochondrial variant through a different query field.
 */
export function isGnomadVariantId(id: string): boolean {
    const upper = id.toUpperCase();
    const parts = (upper.startsWith("CHR") ? upper.slice("CHR".length) : upper).replaceAll(":", "-").split("-");
    if (parts.length !== 4) return false;
    const [chrom = "", pos = "", ref = "", alt = ""] = parts;
    const position = Number(pos);
    return CHROMOSOMES.has(chrom) && Number.isSafeInteger(position) && position > 0 && String(position) === pos && isAllele(ref) && isAllele(alt);
}

const NOT_FOUND_MESSAGE = "Variant not found";

export type GnomadPopulation = {
    /** The genetic ancestry group, for example `afr` or `nfe`. */
    id: string;
    ac: number;
    an: number;
    /** `ac / an`, or null when `an` is 0. */
    af: number | null;
};

export type GnomadCallset = {
    /** The allele count. */
    ac: number | null;
    /** The allele number: the count of called alleles at the site. */
    an: number | null;
    /** The allele frequency. */
    af: number | null;
    populations: GnomadPopulation[];
};

export type GnomadVariant = {
    /** The variant ID of the request that this record answers. */
    query: string;
    /** The variant ID that gnomAD normalized. */
    variantId: string;
    rsids: string[];
    /** null when the dataset has no genome callset, or no genome call at the variant. */
    genome: GnomadCallset | null;
    /** null when the dataset has no exome callset, or no exome call at the variant. */
    exome: GnomadCallset | null;
};

export type GnomadFrequencies = {
    dataset: GnomadDataset;
    referenceGenome: ReferenceGenome;
    variants: GnomadVariant[];
    /** Each variant ID that the dataset does not hold. */
    notFound: string[];
};

const PopulationSchema = z.object({ id: z.string(), ac: z.number(), an: z.number() });

const CallsetSchema = z.object({
    ac: z.number().nullable(),
    an: z.number().nullable(),
    af: z.number().nullable(),
    populations: z.array(PopulationSchema.nullable()).nullable(),
});

/** One `variant` field of the answer. */
export const GnomadVariantSchema = z.object({
    variant_id: z.string(),
    rsids: z.array(z.string()).nullable(),
    genome: CallsetSchema.nullable(),
    exome: CallsetSchema.nullable(),
});

/**
 * The GraphQL answer of a batch: one alias for each variant (`v0`, `v1`, …). `data` is absent when gnomAD refuses
 * the query before it runs, and `errors` is absent when no field failed.
 */
export const GnomadAnswerSchema = z.object({
    data: z.record(z.string(), GnomadVariantSchema.nullable()).nullish(),
    errors: z.array(z.object({ message: z.string() })).optional(),
});

/** A top-level ancestry group has a lowercase id with no `_` and no `:`, unlike a split by sex (`afr_XX`, `XY`) and a cohort (`1kg:ceu`). */
const isAncestryGroup = (id: string): boolean => id === id.toLowerCase() && !id.includes("_") && !id.includes(":");

const VARIANT_FRAGMENTS =
    "fragment Frequencies on VariantDetails { variant_id rsids genome { ...Callset } exome { ...Callset } } " +
    "fragment Callset on VariantDetailsSequencingTypeData { ac an af populations { id ac an } }";

/** The query of a batch of `count` variants. */
function batchQuery(count: number): string {
    const aliases = Array.from({ length: count }, (_, i) => `v${i}`);
    const params = aliases.map((alias) => `$${alias}: String!`).join(", ");
    const fields = aliases.map((alias) => `${alias}: variant(variantId: $${alias}, dataset: $dataset) { ...Frequencies }`).join(" ");
    return `query VariantFrequencies($dataset: DatasetId!, ${params}) { ${fields} } ${VARIANT_FRAGMENTS}`;
}

function toCallset(callset: z.infer<typeof CallsetSchema> | null): GnomadCallset | null {
    if (callset === null) return null;
    const populations = (callset.populations ?? []).flatMap((group) =>
        group !== null && isAncestryGroup(group.id) ? [{ ...group, af: group.an > 0 ? group.ac / group.an : null }] : [],
    );
    return { ac: callset.ac, an: callset.an, af: callset.af, populations };
}

/**
 * Map the answer of a batch to the frequencies of its variants. `queries` is the batch in alias order: `v0` answers
 * the first query. Throws on an error that is not a miss.
 */
export function mapGnomadAnswer(answer: z.infer<typeof GnomadAnswerSchema>, queries: readonly string[], dataset: GnomadDataset): GnomadFrequencies {
    // A rate limit, a query that costs too much, and an invalid query each answer with a message that is not a miss.
    const failure = answer.errors?.find((error) => error.message !== NOT_FOUND_MESSAGE);
    if (failure !== undefined) throw new Error(`gnomAD: ${failure.message}`);
    const data = answer.data;
    if (data === null || data === undefined) throw new Error("gnomAD returned no data");

    const variants: GnomadVariant[] = [];
    const notFound: string[] = [];
    for (const [i, query] of queries.entries()) {
        const variant = data[`v${i}`];
        if (variant === null || variant === undefined) {
            notFound.push(query);
            continue;
        }
        variants.push({
            query,
            variantId: variant.variant_id,
            rsids: variant.rsids ?? [],
            genome: toCallset(variant.genome),
            exome: toCallset(variant.exome),
        });
    }
    return { dataset, referenceGenome: referenceGenomeOf(dataset), variants, notFound };
}

/**
 * The frequencies of a batch of variants in one dataset, in one request. A duplicate ID is sent one time, and the
 * order of the input is kept.
 */
export async function getVariantFrequencies(variantIds: readonly string[], dataset: GnomadDataset): Promise<GnomadFrequencies> {
    const queries = [...new Set(variantIds.map((id) => id.trim()).filter((id) => id !== ""))];
    if (queries.length === 0) return { dataset, referenceGenome: referenceGenomeOf(dataset), variants: [], notFound: [] };
    if (queries.length > GNOMAD_MAX_VARIANTS) throw new Error(`gnomAD takes at most ${GNOMAD_MAX_VARIANTS} variants in one request, not ${queries.length}`);

    const variables: Record<string, string> = { dataset, ...Object.fromEntries(queries.map((id, i): [string, string] => [`v${i}`, id])) };
    const res = await withHost("gnomad", async () =>
        apiFetchValidated(GNOMAD_API, GnomadAnswerSchema, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: batchQuery(queries.length), variables }),
        }),
    );
    if (res.isErr()) throw new Error(`gnomAD: ${describeApiError(res.error)}`);
    return mapGnomadAnswer(res.value, queries, dataset);
}
