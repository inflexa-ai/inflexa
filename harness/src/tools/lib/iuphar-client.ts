/**
 * Pure async client functions for the IUPHAR Guide to Pharmacology
 * (https://www.guidetopharmacology.org/services/) REST API.
 *
 * Used to discover, for any HGNC target or UniProt accession, the obligate
 * heterodimer complexes that share the same primary protein (e.g., AMY1/
 * AMY2/AMY3 amylin receptors share the CT receptor protein with the
 * calcitonin receptor and differ only by their RAMP accessory). Powers
 * data-driven heterodimer filtering in target-assessment so off-target
 * panels never list a sibling receptor-complex as a developable hit.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, type ApiError } from "./api-utils.js";
import { IUPHAR_BASE, IUPHAR_HEADERS as HEADERS } from "./iuphar-config.js";

// Validated at the fetch boundary. GtoPdb returns familyIds/complexIds as
// arrays on every target, and the resolver reads `.length` / iterates them
// without a guard, so they stay required — a missing value surfaces as
// `invalid_response` rather than a runtime TypeError. subunitIds and type are
// only read behind a guard, so they may be absent.
const IupharTargetSchema = z.object({
    targetId: z.number(),
    name: z.string(),
    type: z.string().nullable().optional(),
    familyIds: z.array(z.number()),
    subunitIds: z.array(z.number()).optional(),
    complexIds: z.array(z.number()),
    subunitType: z.string().optional(),
});
export type IupharTarget = z.infer<typeof IupharTargetSchema>;

export interface IupharHeterodimer {
    /** Complex target record (e.g., the AMY1 receptor). */
    complex: IupharTarget;
    /** All subunits of the complex, including the primary protein and accessory(ies). */
    subunits: IupharTarget[];
    /** Accessory-protein subunits only (type === "AccessoryProtein"). */
    accessories: IupharTarget[];
}

const UNIPROT_ACCESSION_RE = /^[A-Z][0-9][A-Z0-9]{3}[0-9]$/;

function stripHtml(name: string): string {
    // Strip tags to a fixpoint: a single pass can leave a `<…>` behind when
    // removing an inner tag lets the surrounding angle brackets form a new one,
    // so repeat until the string stops changing.
    let out = name;
    let prev: string;
    do {
        prev = out;
        out = out.replace(/<[^>]+>/g, "");
    } while (out !== prev);
    return out;
}

function notFound(error: ApiError): boolean {
    return error.type === "http_status" && (error.status === 404 || error.status === 204);
}

async function fetchTargets(query: string): Promise<IupharTarget[]> {
    const url = `${IUPHAR_BASE}/targets?${query}`;
    const res = await apiFetchValidated(url, z.array(IupharTargetSchema), { headers: HEADERS });
    if (res.isErr()) {
        if (notFound(res.error)) return [];
        throw new Error(describeApiError(res.error));
    }
    return Array.isArray(res.value) ? res.value : [];
}

export async function findTargetByGeneSymbol(geneSymbol: string): Promise<IupharTarget | null> {
    const targets = await fetchTargets(`geneSymbol=${encodeURIComponent(geneSymbol)}`);
    return targets[0] ?? null;
}

export async function findTargetByUniprot(accession: string): Promise<IupharTarget | null> {
    const targets = await fetchTargets(`accession=${encodeURIComponent(accession)}&database=UniProt`);
    return targets[0] ?? null;
}

/**
 * Resolve a target by either a UniProt accession or HGNC gene symbol.
 * Tries the format that matches the input shape first, then falls back.
 */
export async function resolveTarget(uniprotOrGeneSymbol: string): Promise<IupharTarget | null> {
    const input = uniprotOrGeneSymbol.trim();
    if (!input) return null;
    if (UNIPROT_ACCESSION_RE.test(input)) {
        return (await findTargetByUniprot(input)) ?? (await findTargetByGeneSymbol(input));
    }
    return (await findTargetByGeneSymbol(input)) ?? (await findTargetByUniprot(input));
}

export async function getSubunits(complexId: number): Promise<IupharTarget[]> {
    const url = `${IUPHAR_BASE}/targets/${complexId}/subunits`;
    const res = await apiFetchValidated(url, z.array(IupharTargetSchema), { headers: HEADERS });
    if (res.isErr()) {
        if (notFound(res.error)) return [];
        throw new Error(describeApiError(res.error));
    }
    return Array.isArray(res.value) ? res.value : [];
}

/**
 * Get the heterodimer / family complexes that contain the primary target
 * (e.g., for CALCR → the AMY1/AMY2/AMY3 amylin receptors, each carrying a
 * RAMP1/2/3 accessory). Names are stripped of IUPHAR's HTML subscript markup.
 *
 * Returns [] when the target isn't resolvable in GtoPdb or has no
 * registered complexes.
 */
export async function getFamilyHeterodimers(uniprotOrGeneSymbol: string): Promise<IupharHeterodimer[]> {
    const target = await resolveTarget(uniprotOrGeneSymbol);
    if (!target || target.complexIds.length === 0) return [];

    const url = `${IUPHAR_BASE}/targets/${target.targetId}/complexes`;
    const res = await apiFetchValidated(url, z.array(IupharTargetSchema), { headers: HEADERS });
    if (res.isErr()) {
        if (notFound(res.error)) return [];
        throw new Error(describeApiError(res.error));
    }
    const complexes = Array.isArray(res.value) ? res.value : [];

    const results: IupharHeterodimer[] = [];
    const concurrency = 5;
    for (let i = 0; i < complexes.length; i += concurrency) {
        const batch = complexes.slice(i, i + concurrency);
        const subunitLists = await Promise.all(batch.map((c) => getSubunits(c.targetId)));
        for (let j = 0; j < batch.length; j++) {
            const complex = batch[j]!;
            const subunits = subunitLists[j]!;
            const cleanedSubunits = subunits.map((s) => ({ ...s, name: stripHtml(s.name) }));
            const accessories = cleanedSubunits.filter((s) => (s.type ?? "").toLowerCase() === "accessoryprotein");
            results.push({
                complex: { ...complex, name: stripHtml(complex.name) },
                subunits: cleanedSubunits,
                accessories,
            });
        }
    }
    return results;
}

/**
 * Distinct accessory-protein gene symbols across all heterodimer complexes
 * containing the primary target. Used to build a runtime regex alternation
 * for heterodimer-name filtering instead of hardcoding RAMP/MRAP/RGS.
 *
 * Example: getAccessoryProteinNames("CALCR") → ["RAMP1", "RAMP2", "RAMP3"].
 */
export async function getAccessoryProteinNames(uniprotOrGeneSymbol: string): Promise<string[]> {
    const heterodimers = await getFamilyHeterodimers(uniprotOrGeneSymbol);
    const names = new Set<string>();
    for (const h of heterodimers) {
        for (const acc of h.accessories) {
            const cleaned = acc.name.trim();
            if (cleaned) names.add(cleaned);
        }
    }
    return [...names].sort();
}

// getFamilySiblingUniprots iterates `targetIds` without a guard, so it stays
// required; the other fields are not read, so they may be absent.
const IupharFamilySchema = z.object({
    familyId: z.number().optional(),
    name: z.string().optional(),
    targetIds: z.array(z.number()),
    parentFamilyIds: z.array(z.number()).optional(),
    subFamilyIds: z.array(z.number()).optional(),
});
export type IupharFamily = z.infer<typeof IupharFamilySchema>;

export async function getFamily(familyId: number): Promise<IupharFamily | null> {
    const url = `${IUPHAR_BASE}/targets/families/${familyId}`;
    const res = await apiFetchValidated(url, IupharFamilySchema, { headers: HEADERS });
    if (res.isErr()) {
        if (notFound(res.error)) return null;
        throw new Error(describeApiError(res.error));
    }
    return res.value;
}

const IupharDatabaseLinkSchema = z.object({
    accession: z.string().optional(),
    database: z.string().optional(),
    species: z.string().optional(),
});

/** Fetch the UniProtKB cross-references (human only) for an IUPHAR target. */
export async function getTargetHumanUniprots(targetId: number): Promise<string[]> {
    const url = `${IUPHAR_BASE}/targets/${targetId}/databaseLinks`;
    const res = await apiFetchValidated(url, z.array(IupharDatabaseLinkSchema), { headers: HEADERS });
    if (res.isErr()) {
        if (notFound(res.error)) return [];
        throw new Error(describeApiError(res.error));
    }
    const links = Array.isArray(res.value) ? res.value : [];
    const out: string[] = [];
    for (const l of links) {
        if (l.database !== "UniProtKB") continue;
        if ((l.species ?? "").toLowerCase() !== "human") continue;
        if (l.accession) out.push(l.accession);
    }
    return out;
}

/**
 * UniProt accessions of sibling primary-GPCR targets in the same IUPHAR
 * family as the input (excludes the input target itself and any target
 * registered as a complex with subunits). For CALCR this returns the
 * CALCRL accession; the AMY1/2/3 complexes are excluded because they are
 * heterodimers, not separate primary proteins.
 */
export async function getFamilySiblingUniprots(uniprotOrGeneSymbol: string): Promise<string[]> {
    const self = await resolveTarget(uniprotOrGeneSymbol);
    if (!self) return [];
    const selfUniprots = new Set(await getTargetHumanUniprots(self.targetId));

    const siblingIds = new Set<number>();
    for (const familyId of self.familyIds) {
        const family = await getFamily(familyId);
        if (!family) continue;
        for (const tid of family.targetIds) {
            if (tid !== self.targetId) siblingIds.add(tid);
        }
    }
    if (siblingIds.size === 0) return [];

    const out = new Set<string>();
    const ids = [...siblingIds];
    const concurrency = 5;
    for (let i = 0; i < ids.length; i += concurrency) {
        const batch = ids.slice(i, i + concurrency);
        // Fetch target details and their UniProt cross-references in parallel.
        // Complexes (non-empty subunitIds) are skipped — those are covered by
        // the family-complexes collector, not the family-sibling resolver.
        const uniprotLists = await Promise.all(
            batch.map(async (tid) => {
                const url = `${IUPHAR_BASE}/targets/${tid}`;
                const res = await apiFetchValidated(url, IupharTargetSchema, { headers: HEADERS });
                if (res.isErr()) return [];
                const t = res.value;
                if (t.subunitIds && t.subunitIds.length > 0) return [];
                return getTargetHumanUniprots(t.targetId);
            }),
        );
        for (const accs of uniprotLists) {
            for (const a of accs) {
                if (!selfUniprots.has(a)) out.add(a);
            }
        }
    }
    return [...out].sort();
}
