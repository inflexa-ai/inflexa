/**
 * Pure async client functions for the ChEMBL REST API.
 *
 * Used directly by target-assessment workflow steps and by tool wrappers.
 *
 * Absence policy: ChEMBL sends an explicit `null` for an absent value, and it
 * never omits the key. Thus a maybe-absent field carries `.nullable()`, not
 * `.optional()`.
 */

import { z } from "zod";

import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { apiFetchValidated, describeApiError, isUnexpectedApiError, zWireNumber, type ApiError } from "./api-utils.js";
import { CHEMBL_BASE, CHEMBL_HEADERS as HEADERS } from "./chembl-config.js";

/** The `max_phase` of an approved drug. ChEMBL serializes it as the string "4.0". */
const APPROVED_MAX_PHASE = 4;

/**
 * Report one molecule that a per-molecule lookup dropped from its result.
 *
 * These loops turned every error into a skipped molecule, thus a ChEMBL contract
 * break emptied a whole modulator list in silence. An unexpected cause now
 * reaches the injected `Logger` before the loop degrades. An expected miss, such
 * as an HTTP 404, stays silent, because ChEMBL holds no record of that molecule.
 */
function reportSkippedMolecule(logger: Logger, error: ApiError, moleculeChemblId: string): void {
    if (!isUnexpectedApiError(error)) return;
    logger.error("molecule dropped from the result", { moleculeChemblId, cause: describeApiError(error) });
}

/** How many disease terms one drug can contribute to an indication read. */
const INDICATIONS_PER_DRUG = 20;

export interface ChemblCompound {
    chemblId: string;
    preferredCompoundName: string | null;
    canonicalSmiles: string | null;
    molecularWeight: number | null;
    alogp: number | null;
    molecularFormula: string | null;
}

/** How `searchCompounds` interprets its query string. */
export type CompoundSearchType = "target" | "compound" | "smiles";

export interface ChemblTarget {
    targetChemblId: string;
    preferredName: string | null;
    targetType: string | null;
    organism: string | null;
    geneNames: string[];
}

export interface ChemblActivity {
    activityId: number | null;
    compoundChemblId: string;
    targetChemblId: string | null;
    standardType: string | null;
    standardValue: number | null;
    standardUnits: string | null;
    assayChemblId: string | null;
    assayType: string | null;
    pchemblValue: number | null;
}

export interface ChemblMechanism {
    mechanismOfAction: string | null;
    actionType: string | null;
    targetChemblId: string | null;
    targetName: string | null;
    moleculeChemblId: string;
}

export interface ChemblDrug {
    moleculeChemblId: string;
    preferredName: string | null;
    maxPhase: number | null;
    moleculeType: string | null;
    firstApproval: number | null;
    indication: string | null;
}

export interface ChemblModulator {
    moleculeChemblId: string;
    parentChemblId: string | null;
    preferredName: string | null;
    maxPhase: number | null;
    moleculeType: string | null;
    firstApproval: number | null;
}

export interface ChemblPolypharmHit {
    moleculeChemblId: string;
    targetChemblId: string;
    targetName: string | null;
    /** The assay the reported activity was measured in, when ChEMBL names one. */
    assayChemblId: string | null;
    standardType: string | null;
    standardValue: number | null;
    standardUnits: string | null;
    pchemblValue: number | null;
}

const TargetComponentSynonymSchema = z.object({
    syn_type: z.string().optional(),
    component_synonym: z.string().optional(),
});

const TargetComponentSchema = z.object({
    accession: z.string().optional(),
    target_component_synonyms: z.array(TargetComponentSynonymSchema).optional(),
});
type TargetComponent = z.infer<typeof TargetComponentSchema>;

const RawTargetSchema = z.object({
    target_chembl_id: z.string().optional(),
    pref_name: z.string().optional(),
    target_type: z.string().optional(),
    organism: z.string().nullable().optional(),
    target_components: z.array(TargetComponentSchema).optional(),
});
type RawTarget = z.infer<typeof RawTargetSchema>;

// ChEMBL serves a Tastypie `decimal` as a JSON string ("41.0"), and it encodes an
// absent value as an explicit `null` rather than an omitted key. Thus a decimal
// field reads through `zWireNumber`, and a field that the published schema marks
// nullable carries `.nullable()`.

/** A raw activity row from the ChEMBL `activity` endpoint. */
const RawChemblActivitySchema = z.object({
    activity_id: z.number().optional(),
    molecule_chembl_id: z.string().optional(),
    target_chembl_id: z.string().optional(),
    standard_type: z.string().optional(),
    standard_value: zWireNumber.nullable().optional(),
    standard_units: z.string().nullable().optional(),
    assay_chembl_id: z.string().optional(),
    assay_type: z.string().optional(),
    pchembl_value: zWireNumber.nullable().optional(),
});

/** A raw mechanism row from the ChEMBL `mechanism` endpoint. */
const RawChemblMechanismSchema = z.object({
    mechanism_of_action: z.string().optional(),
    action_type: z.string().nullable().optional(),
    target_chembl_id: z.string().nullable().optional(),
    molecule_chembl_id: z.string().optional(),
});

/** A raw row of the ChEMBL `drug_indication` resource, which pairs a molecule with a disease term. */
const RawDrugIndicationSchema = z.object({
    molecule_chembl_id: z.string().nullable().optional(),
    mesh_heading: z.string().optional(),
    efo_term: z.string().nullable().optional(),
    max_phase_for_ind: zWireNumber.nullable().optional(),
});
type RawDrugIndication = z.infer<typeof RawDrugIndicationSchema>;

/** A raw molecule record from the ChEMBL `molecule` endpoint. */
const RawChemblMoleculeSchema = z.object({
    molecule_chembl_id: z.string().optional(),
    pref_name: z.string().nullable().optional(),
    max_phase: zWireNumber.nullable().optional(),
    molecule_type: z.string().nullable().optional(),
    first_approval: z.number().nullable().optional(),
    molecule_hierarchy: z.object({ parent_chembl_id: z.string().optional() }).optional(),
});
type RawChemblMolecule = z.infer<typeof RawChemblMoleculeSchema>;

// Response envelopes returned by the ChEMBL list/record endpoints, validated at
// the fetch boundary. Every wrapper field is optional because the API omits it
// when there is no data (a 404 is handled separately as an expected empty).
export const TargetSearchResponseSchema = z.object({ targets: z.array(RawTargetSchema).optional() });
export const ActivitiesResponseSchema = z.object({ activities: z.array(RawChemblActivitySchema).optional() });
export const MechanismsResponseSchema = z.object({ mechanisms: z.array(RawChemblMechanismSchema).optional() });
export const DrugIndicationsResponseSchema = z.object({ drug_indications: z.array(RawDrugIndicationSchema).optional() });
export const MoleculeSearchResponseSchema = z.object({ molecules: z.array(RawChemblMoleculeSchema).optional() });
const TargetNameResponseSchema = z.object({ pref_name: z.string().optional() });
export const MoleculeStructuresResponseSchema = z.object({
    molecule_structures: z.object({ standard_inchi_key: z.string().nullable().optional() }).nullable().optional(),
});
const TargetComponentsResponseSchema = z.object({
    target_components: z.array(z.object({ accession: z.string().optional(), component_type: z.string().optional() })).optional(),
});

// A single schema that both validates and normalizes one ChEMBL molecule
// record for the compound search: the `.object(...)` half is the snake_case wire
// shape (every field optional — ChEMBL omits absent values), the
// `.transform(...)` half maps it to the camelCase `ChemblCompound` we return.
// Parsing IS the validation, so there is no separate raw interface or mapper.
const CompoundRecordSchema = z
    .object({
        molecule_chembl_id: z.string().optional(),
        // ChEMBL sends explicit `null` (not omission) for an unnamed compound, and
        // `null` for the whole structures/properties blocks on biologics/antibodies
        // — `.nullable()` so those rows parse instead of failing the `molecules` array.
        pref_name: z.string().nullable().optional(),
        molecule_structures: z
            .object({
                canonical_smiles: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
        molecule_properties: z
            .object({
                full_mwt: zWireNumber.nullable().optional(),
                alogp: zWireNumber.nullable().optional(),
                // `full_molformula` is the wire name of the molecular formula. The
                // `molecule_properties` block carries no `molecular_formula` key.
                full_molformula: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
    })
    .transform((raw): ChemblCompound => ({
        chemblId: raw.molecule_chembl_id ?? "",
        preferredCompoundName: raw.pref_name ?? null,
        canonicalSmiles: raw.molecule_structures?.canonical_smiles ?? null,
        molecularWeight: raw.molecule_properties?.full_mwt ?? null,
        alogp: raw.molecule_properties?.alogp ?? null,
        molecularFormula: raw.molecule_properties?.full_molformula ?? null,
    }));

export const CompoundsResponseSchema = z.object({ molecules: z.array(CompoundRecordSchema).optional() });

// The two hops of the target-mode compound search read one id each, so they
// project the response down to that id rather than reusing the richer
// target/activity schemas above.
const CompoundTargetIdResponseSchema = z.object({ targets: z.array(z.object({ target_chembl_id: z.string().optional() })).optional() });
const CompoundActivityIdResponseSchema = z.object({ activities: z.array(z.object({ molecule_chembl_id: z.string().optional() })).optional() });

function extractGeneNames(components?: TargetComponent[]): string[] {
    if (!components?.length) return [];
    const genes = new Set<string>();
    for (const comp of components) {
        for (const syn of comp.target_component_synonyms ?? []) {
            if (syn.syn_type === "GENE_SYMBOL" && syn.component_synonym) {
                genes.add(syn.component_synonym);
            }
        }
    }
    if (genes.size === 0) {
        for (const comp of components) {
            if (comp.accession) genes.add(comp.accession);
        }
    }
    return [...genes];
}

function mapTarget(raw: RawTarget): ChemblTarget {
    return {
        targetChemblId: raw.target_chembl_id ?? "",
        preferredName: raw.pref_name ?? null,
        targetType: raw.target_type ?? null,
        organism: raw.organism ?? null,
        geneNames: extractGeneNames(raw.target_components),
    };
}

/**
 * Compounds assayed against a target: resolve the query to a target ChEMBL ID,
 * read that target's activity rows, then fetch the unique molecules behind them.
 * `limit` caps the activity rows scanned, so the compound count is usually lower.
 */
async function searchCompoundsByTarget(query: string, limit: number): Promise<ChemblCompound[]> {
    const targetRes = await apiFetchValidated(`${CHEMBL_BASE}/target/search.json?q=${encodeURIComponent(query)}&limit=1`, CompoundTargetIdResponseSchema, {
        headers: HEADERS,
    });
    if (targetRes.isErr()) {
        if (targetRes.error.type === "http_status" && targetRes.error.status === 404) return [];
        throw new Error(describeApiError(targetRes.error));
    }
    if (!targetRes.value.targets?.length) return [];

    const targetChemblId = targetRes.value.targets[0].target_chembl_id;
    if (!targetChemblId) return [];

    const activityRes = await apiFetchValidated(
        `${CHEMBL_BASE}/activity.json?target_chembl_id=${targetChemblId}&limit=${limit}`,
        CompoundActivityIdResponseSchema,
        {
            headers: HEADERS,
        },
    );
    if (activityRes.isErr()) {
        if (activityRes.error.type === "http_status" && activityRes.error.status === 404) return [];
        throw new Error(describeApiError(activityRes.error));
    }
    if (!activityRes.value.activities?.length) return [];

    const uniqueIds = new Set<string>();
    for (const act of activityRes.value.activities) {
        if (act.molecule_chembl_id) uniqueIds.add(act.molecule_chembl_id);
    }

    const compounds: ChemblCompound[] = [];
    const idArray = [...uniqueIds];
    // Fetch in batches of 50 to avoid overly long URLs.
    const batchSize = 50;
    for (let i = 0; i < idArray.length; i += batchSize) {
        const batch = idArray.slice(i, i + batchSize);
        const idsParam = batch.join(";");
        const molRes = await apiFetchValidated(`${CHEMBL_BASE}/molecule/set/${idsParam}.json`, CompoundsResponseSchema, { headers: HEADERS });
        if (molRes.isErr()) {
            if (!(molRes.error.type === "http_status" && molRes.error.status === 404)) {
                throw new Error(describeApiError(molRes.error));
            }
            continue;
        }
        if (molRes.value.molecules) {
            for (const mol of molRes.value.molecules) {
                compounds.push(mol);
            }
        }
    }

    return compounds;
}

/** Free-text search over molecule names. */
async function searchCompoundsByName(query: string, limit: number): Promise<ChemblCompound[]> {
    const res = await apiFetchValidated(`${CHEMBL_BASE}/molecule/search.json?q=${encodeURIComponent(query)}&limit=${limit}`, CompoundsResponseSchema, {
        headers: HEADERS,
    });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return res.value.molecules ?? [];
}

/** Flexible (flexmatch) structure search on canonical SMILES. */
async function searchCompoundsBySmiles(smiles: string, limit: number): Promise<ChemblCompound[]> {
    const res = await apiFetchValidated(
        `${CHEMBL_BASE}/molecule.json?molecule_structures__canonical_smiles__flexmatch=${encodeURIComponent(smiles)}&limit=${limit}`,
        CompoundsResponseSchema,
        { headers: HEADERS },
    );
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return res.value.molecules ?? [];
}

/** Search ChEMBL for compounds by target, compound name, or SMILES. */
export async function searchCompounds(query: string, searchType: CompoundSearchType, limit = 500): Promise<ChemblCompound[]> {
    if (searchType === "target") return searchCompoundsByTarget(query, limit);
    if (searchType === "smiles") return searchCompoundsBySmiles(query, limit);
    return searchCompoundsByName(query, limit);
}

export async function searchTargets(query: string, limit = 25): Promise<ChemblTarget[]> {
    const url = `${CHEMBL_BASE}/target/search.json?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await apiFetchValidated(url, TargetSearchResponseSchema, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return (res.value.targets ?? []).map(mapTarget);
}

/** Which column of the ChEMBL activity table the supplied id indexes. */
export type BioactivityIdType = "compound" | "target" | "assay";

const ACTIVITY_ID_FIELD: Record<BioactivityIdType, string> = {
    compound: "molecule_chembl_id",
    target: "target_chembl_id",
    assay: "assay_chembl_id",
};

export async function getBioactivity(
    chemblId: string,
    type: BioactivityIdType,
    options: { activityType?: string; limit?: number } = {},
): Promise<ChemblActivity[]> {
    const limit = options.limit ?? 500;
    const idParam = `${ACTIVITY_ID_FIELD[type]}=${encodeURIComponent(chemblId)}`;
    let url = `${CHEMBL_BASE}/activity.json?${idParam}&limit=${limit}`;
    if (options.activityType) {
        url += `&standard_type=${encodeURIComponent(options.activityType)}`;
    }

    const res = await apiFetchValidated(url, ActivitiesResponseSchema, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    return (res.value.activities ?? []).map((raw) => ({
        activityId: raw.activity_id != null ? raw.activity_id : null,
        compoundChemblId: raw.molecule_chembl_id ?? "",
        targetChemblId: raw.target_chembl_id ?? null,
        standardType: raw.standard_type ?? null,
        standardValue: raw.standard_value ?? null,
        standardUnits: raw.standard_units ?? null,
        assayChemblId: raw.assay_chembl_id ?? null,
        assayType: raw.assay_type ?? null,
        pchemblValue: raw.pchembl_value ?? null,
    }));
}

async function fetchTargetName(targetChemblId: string): Promise<string | null> {
    const res = await apiFetchValidated(`${CHEMBL_BASE}/target/${targetChemblId}.json`, TargetNameResponseSchema, { headers: HEADERS });
    if (res.isErr() || !res.value.pref_name) return null;
    return res.value.pref_name;
}

export async function getMechanism(chemblId: string): Promise<ChemblMechanism[]> {
    const url = `${CHEMBL_BASE}/mechanism.json?molecule_chembl_id=${encodeURIComponent(chemblId)}`;
    const res = await apiFetchValidated(url, MechanismsResponseSchema, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    const rawMechanisms = res.value.mechanisms ?? [];

    const targetIds = new Set<string>();
    for (const mech of rawMechanisms) {
        if (mech.target_chembl_id) targetIds.add(mech.target_chembl_id);
    }
    const targetNames = new Map<string, string>();
    const targetIdArray = [...targetIds];
    const concurrency = 5;
    for (let i = 0; i < targetIdArray.length; i += concurrency) {
        const batch = targetIdArray.slice(i, i + concurrency);
        const names = await Promise.all(batch.map(fetchTargetName));
        for (const [idx, id] of batch.entries()) {
            const name = names[idx];
            if (name) targetNames.set(id, name);
        }
    }

    return rawMechanisms.map((raw) => ({
        mechanismOfAction: raw.mechanism_of_action ?? null,
        actionType: raw.action_type ?? null,
        targetChemblId: raw.target_chembl_id ?? null,
        targetName: targetNames.get(raw.target_chembl_id ?? "") ?? null,
        moleculeChemblId: raw.molecule_chembl_id ?? "",
    }));
}

function mapDrug(raw: RawChemblMolecule, indication: string | null): ChemblDrug {
    return {
        moleculeChemblId: raw.molecule_chembl_id ?? "",
        preferredName: raw.pref_name ?? null,
        maxPhase: raw.max_phase ?? null,
        moleculeType: raw.molecule_type ?? null,
        firstApproval: raw.first_approval ?? null,
        indication,
    };
}

/** Join the disease terms of one molecule. The MeSH heading is the curated name, thus it comes first. */
function joinIndicationTerms(rows: RawDrugIndication[]): string | null {
    const terms = new Set<string>();
    for (const row of rows) {
        const term = row.mesh_heading ?? row.efo_term;
        if (term) terms.add(term);
    }
    return terms.size > 0 ? [...terms].join("; ") : null;
}

/**
 * Read the `drug_indication` resource under one filter.
 *
 * The rows come highest-phase first, thus an approved indication survives the
 * `limit` of a disease that hundreds of molecules carry.
 */
async function fetchDrugIndications(filter: string, limit: number): Promise<RawDrugIndication[]> {
    const url = `${CHEMBL_BASE}/drug_indication.json?${filter}&order_by=-max_phase_for_ind&limit=${limit}`;
    const res = await apiFetchValidated(url, DrugIndicationsResponseSchema, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return res.value.drug_indications ?? [];
}

/** Read one batch of molecule records by id. */
async function fetchMoleculeSet(moleculeChemblIds: string[]): Promise<RawChemblMolecule[]> {
    const res = await apiFetchValidated(`${CHEMBL_BASE}/molecule/set/${moleculeChemblIds.join(";")}.json`, MoleculeSearchResponseSchema, {
        headers: HEADERS,
    });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return res.value.molecules ?? [];
}

/** Collect the indication rows of each molecule, up to `maxMolecules` molecules. */
function groupIndicationsByMolecule(rows: RawDrugIndication[], maxMolecules: number): Map<string, RawDrugIndication[]> {
    const byMolecule = new Map<string, RawDrugIndication[]>();
    for (const row of rows) {
        const moleculeChemblId = row.molecule_chembl_id;
        if (!moleculeChemblId) continue;
        const collected = byMolecule.get(moleculeChemblId);
        if (collected) collected.push(row);
        else if (byMolecule.size < maxMolecules) byMolecule.set(moleculeChemblId, [row]);
    }
    return byMolecule;
}

/** The drugs that ChEMBL indexes under a disease term, with the terms that matched. */
async function searchDrugsByIndication(query: string, limit: number): Promise<ChemblDrug[]> {
    const encoded = encodeURIComponent(query);
    // The two filters cover the two vocabularies of the resource. EFO comes first,
    // because it carries the finer term, and a MeSH-only query still reaches the
    // second read.
    let rows = await fetchDrugIndications(`efo_term__icontains=${encoded}`, limit);
    if (rows.length === 0) rows = await fetchDrugIndications(`mesh_heading__icontains=${encoded}`, limit);

    const byMolecule = groupIndicationsByMolecule(rows, limit);
    if (byMolecule.size === 0) return [];

    const molecules = await fetchMoleculeSet([...byMolecule.keys()]);
    return molecules.map((raw) => mapDrug(raw, joinIndicationTerms(byMolecule.get(raw.molecule_chembl_id ?? "") ?? [])));
}

/** The indication terms of each named molecule, keyed by the molecule id. */
async function fetchIndicationsOf(moleculeChemblIds: string[]): Promise<Map<string, string>> {
    if (moleculeChemblIds.length === 0) return new Map();
    // A molecule carries one row for each disease term, thus the cap scales with the
    // number of molecules that the caller resolved.
    const rows = await fetchDrugIndications(`molecule_chembl_id__in=${moleculeChemblIds.join(",")}`, moleculeChemblIds.length * INDICATIONS_PER_DRUG);

    const terms = new Map<string, string>();
    for (const [moleculeChemblId, collected] of groupIndicationsByMolecule(rows, moleculeChemblIds.length)) {
        const joined = joinIndicationTerms(collected);
        if (joined) terms.set(moleculeChemblId, joined);
    }
    return terms;
}

/** The approved molecules whose name matches the query. */
async function searchApprovedDrugsByName(query: string, limit: number): Promise<ChemblDrug[]> {
    const url = `${CHEMBL_BASE}/molecule/search.json?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await apiFetchValidated(url, MoleculeSearchResponseSchema, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    const approved = (res.value.molecules ?? []).filter((mol) => mol.max_phase != null && mol.max_phase >= APPROVED_MAX_PHASE);
    if (approved.length === 0) return [];

    const moleculeChemblIds = approved.map((mol) => mol.molecule_chembl_id).filter((id): id is string => id !== undefined && id.length > 0);
    const indications = await fetchIndicationsOf(moleculeChemblIds);
    return approved.map((raw) => mapDrug(raw, indications.get(raw.molecule_chembl_id ?? "") ?? null));
}

/**
 * Approved drugs by name or by disease term.
 *
 * The `drug` resource of ChEMBL has no search endpoint, and it carries neither a
 * name nor an indication. Thus the lookup reads the `drug_indication` resource
 * first, and it falls back to the molecule search when no disease term matches.
 */
export async function getDrugInfo(query: string, limit = 25): Promise<ChemblDrug[]> {
    const byIndication = await searchDrugsByIndication(query, limit);
    if (byIndication.length > 0) return byIndication;
    return searchApprovedDrugsByName(query, limit);
}

/**
 * Fetch all clinical-stage modulators (max_phase ≥ 2 by default) for a target.
 * Used for §2.6.6 (class precedent) and as the input to §2.6.4 (off-target panel).
 */
export async function getTargetModulators(
    targetChemblId: string,
    options: { minPhase?: number; limit?: number } = {},
    logger?: Logger,
): Promise<ChemblModulator[]> {
    const log = (logger ?? createNoopLogger()).named("chembl-client.target-modulators").with({ targetChemblId });
    const minPhase = options.minPhase ?? 2;
    const limit = options.limit ?? 200;
    const mechUrl = `${CHEMBL_BASE}/mechanism.json?target_chembl_id=${encodeURIComponent(targetChemblId)}` + `&limit=${limit}`;
    const mechRes = await apiFetchValidated(mechUrl, MechanismsResponseSchema, { headers: HEADERS });
    if (mechRes.isErr()) {
        if (mechRes.error.type === "http_status" && mechRes.error.status === 404) return [];
        throw new Error(describeApiError(mechRes.error));
    }
    const moleculeIds = new Set<string>();
    for (const mech of mechRes.value.mechanisms ?? []) {
        if (mech.molecule_chembl_id) moleculeIds.add(mech.molecule_chembl_id);
    }
    if (moleculeIds.size === 0) return [];

    const modulators: ChemblModulator[] = [];
    const ids = [...moleculeIds];
    const concurrency = 5;
    for (let i = 0; i < ids.length; i += concurrency) {
        const batch = ids.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map(async (id) => {
                const res = await apiFetchValidated(`${CHEMBL_BASE}/molecule/${id}.json`, RawChemblMoleculeSchema, {
                    headers: HEADERS,
                });
                if (res.isErr()) {
                    reportSkippedMolecule(log, res.error, id);
                    return null;
                }
                const m = res.value;
                const phase = m.max_phase ?? null;
                if (phase == null || phase < minPhase) return null;
                return {
                    moleculeChemblId: m.molecule_chembl_id ?? id,
                    parentChemblId: m.molecule_hierarchy?.parent_chembl_id ?? null,
                    preferredName: m.pref_name ?? null,
                    maxPhase: phase,
                    moleculeType: m.molecule_type ?? null,
                    firstApproval: m.first_approval ?? null,
                };
            }),
        );
        for (const r of results) if (r) modulators.push(r);
    }
    return modulators;
}

/**
 * Fetch off-target binding hits for a modulator: every target the molecule
 * has been measured against (excluding the primary target), with potency.
 * Used for §2.6.4 / §2.8 off-target panel.
 */
export async function getModulatorPolypharmacology(
    moleculeChemblId: string,
    options: { minPchembl?: number; limit?: number; excludeTargetChemblId?: string } = {},
): Promise<ChemblPolypharmHit[]> {
    const minPchembl = options.minPchembl ?? 5;
    const limit = options.limit ?? 200;
    const url = `${CHEMBL_BASE}/activity.json?molecule_chembl_id=${encodeURIComponent(moleculeChemblId)}` + `&limit=${limit}&pchembl_value__gte=${minPchembl}`;
    const res = await apiFetchValidated(url, ActivitiesResponseSchema, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    const byTarget = new Map<string, ChemblPolypharmHit>();
    for (const raw of res.value.activities ?? []) {
        const tid = raw.target_chembl_id;
        if (!tid) continue;
        if (options.excludeTargetChemblId && tid === options.excludeTargetChemblId) continue;
        const pchembl = raw.pchembl_value ?? null;
        const existing = byTarget.get(tid);
        if (!existing || (pchembl != null && (existing.pchemblValue == null || pchembl > existing.pchemblValue))) {
            byTarget.set(tid, {
                moleculeChemblId,
                targetChemblId: tid,
                targetName: null,
                assayChemblId: raw.assay_chembl_id ?? null,
                standardType: raw.standard_type ?? null,
                standardValue: raw.standard_value ?? null,
                standardUnits: raw.standard_units ?? null,
                pchemblValue: pchembl,
            });
        }
    }
    const hits = [...byTarget.values()];

    const tids = hits.map((h) => h.targetChemblId);
    const concurrency = 5;
    for (let i = 0; i < tids.length; i += concurrency) {
        const batch = tids.slice(i, i + concurrency);
        const names = await Promise.all(batch.map(fetchTargetName));
        for (const [idx, id] of batch.entries()) {
            const hit = hits.find((h) => h.targetChemblId === id);
            if (hit) hit.targetName = names[idx];
        }
    }

    return hits.sort((a, b) => (b.pchemblValue ?? 0) - (a.pchemblValue ?? 0));
}

/**
 * Fetch the median pChEMBL value for a modulator measured against its primary
 * on-target. Filters to activities with non-null pchembl_value against the
 * specified target ChEMBL ID. Returns null when no activities are found.
 *
 * Used by the polypharm fanout step so the assembler's computeSelectivity
 * can produce real fold values instead of selectivity_unknown.
 */
export async function getModulatorOnTargetPchembl(modulatorChemblId: string, targetChemblId: string): Promise<number | null> {
    const url =
        `${CHEMBL_BASE}/activity.json?molecule_chembl_id=${encodeURIComponent(modulatorChemblId)}` +
        `&target_chembl_id=${encodeURIComponent(targetChemblId)}` +
        `&pchembl_value__isnull=false&limit=10`;
    const res = await apiFetchValidated(url, ActivitiesResponseSchema, { headers: HEADERS });
    if (res.isErr()) return null;
    const values = (res.value.activities ?? []).map((a) => a.pchembl_value ?? null).filter((v): v is number => v !== null);
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

/**
 * Secondary path: fetch clinical-stage small molecules via the activity table.
 *
 * ChEMBL's mechanism table can lag behind for newer programmes (e.g.,
 * orforglipron for GLP1R). Querying the activity table with
 * `max_phase__gte` catches these molecules earlier. The activity table
 * carries `molecule_chembl_id` but not `max_phase` or `molecule_type` —
 * those require a follow-up molecule lookup. We batch unique molecule IDs
 * and fetch molecule records in slices of 5.
 *
 * Returns one `ChemblModulator` per unique molecule that passes the
 * min-phase and molecule-type filters.
 */
export async function getModulatorsViaActivity(
    args: {
        target_chembl_id: string;
        max_phase_min?: number;
        molecule_type?: string;
        limit?: number;
    },
    logger?: Logger,
): Promise<ChemblModulator[]> {
    const { target_chembl_id, max_phase_min = 2, molecule_type, limit = 50 } = args;
    const log = (logger ?? createNoopLogger()).named("chembl-client.modulators-via-activity").with({ targetChemblId: target_chembl_id });

    let url = `${CHEMBL_BASE}/activity.json?target_chembl_id=${encodeURIComponent(target_chembl_id)}` + `&max_phase__gte=${max_phase_min}&limit=${limit}`;
    if (molecule_type) {
        url += `&molecule_type=${encodeURIComponent(molecule_type)}`;
    }

    const res = await apiFetchValidated(url, ActivitiesResponseSchema, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    // Collect unique molecule IDs from activity rows.
    const moleculeIds = new Set<string>();
    for (const row of res.value.activities ?? []) {
        if (row.molecule_chembl_id) moleculeIds.add(row.molecule_chembl_id);
    }
    if (moleculeIds.size === 0) return [];

    const modulators: ChemblModulator[] = [];
    const ids = [...moleculeIds];
    const concurrency = 5;
    for (let i = 0; i < ids.length; i += concurrency) {
        const batch = ids.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map(async (id) => {
                const molRes = await apiFetchValidated(`${CHEMBL_BASE}/molecule/${id}.json`, RawChemblMoleculeSchema, {
                    headers: HEADERS,
                });
                if (molRes.isErr()) {
                    reportSkippedMolecule(log, molRes.error, id);
                    return null;
                }
                const m = molRes.value;
                const phase = m.max_phase ?? null;
                if (phase == null || phase < max_phase_min) return null;
                const molType: string | null = m.molecule_type ?? null;
                if (molecule_type && molType !== molecule_type) return null;
                return {
                    moleculeChemblId: m.molecule_chembl_id ?? id,
                    parentChemblId: m.molecule_hierarchy?.parent_chembl_id ?? null,
                    preferredName: m.pref_name ?? null,
                    maxPhase: phase,
                    moleculeType: molType,
                    firstApproval: m.first_approval ?? null,
                };
            }),
        );
        for (const r of results) if (r) modulators.push(r);
    }
    return modulators;
}

/**
 * Fetch the canonical InChI key for a ChEMBL molecule. Returns null when
 * ChEMBL has no recorded structure (typical for peptide/protein entries
 * with `molecule_type: "Unknown"`).
 */
export async function getMoleculeInChIKey(moleculeChemblId: string): Promise<string | null> {
    const res = await apiFetchValidated(`${CHEMBL_BASE}/molecule/${moleculeChemblId}.json`, MoleculeStructuresResponseSchema, { headers: HEADERS });
    if (res.isErr()) return null;
    return res.value.molecule_structures?.standard_inchi_key ?? null;
}

/**
 * Resolve a drug's mechanism-of-action targets to UniProt accessions.
 * Returns deduplicated accessions across all mechanism rows.
 * Empty array on no mechanism, missing target, or non-protein target.
 *
 * Used by target-identity-filter to detect off-target trials (e.g., a
 * trial of a CALCRL drug being surfaced under a CALCR assessment).
 */
export async function getDrugPrimaryTargetUniprots(moleculeChemblId: string): Promise<string[]> {
    const mechRes = await apiFetchValidated(
        `${CHEMBL_BASE}/mechanism.json?molecule_chembl_id=${encodeURIComponent(moleculeChemblId)}&limit=20`,
        MechanismsResponseSchema,
        { headers: HEADERS },
    );
    if (mechRes.isErr()) return [];
    const targetIds = new Set<string>();
    for (const m of mechRes.value.mechanisms ?? []) {
        if (m.target_chembl_id) targetIds.add(m.target_chembl_id);
    }
    if (targetIds.size === 0) return [];

    const accessions = new Set<string>();
    for (const targetId of targetIds) {
        const tRes = await apiFetchValidated(`${CHEMBL_BASE}/target/${targetId}.json`, TargetComponentsResponseSchema, { headers: HEADERS });
        if (tRes.isErr()) continue;
        for (const c of tRes.value.target_components ?? []) {
            if (c.accession && (c.component_type ?? "").toUpperCase() === "PROTEIN") {
                accessions.add(c.accession);
            }
        }
    }
    return [...accessions];
}
