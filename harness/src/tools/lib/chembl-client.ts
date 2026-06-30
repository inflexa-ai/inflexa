/**
 * Pure async client functions for the ChEMBL REST API.
 *
 * Used directly by target-assessment workflow steps and by tool wrappers.
 */

import { apiFetch, describeApiError } from "./api-utils.js";
import { CHEMBL_BASE, CHEMBL_HEADERS as HEADERS } from "./chembl-config.js";

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
    standardType: string | null;
    standardValue: number | null;
    standardUnits: string | null;
    pchemblValue: number | null;
}

interface TargetComponentSynonym {
    syn_type?: string;
    component_synonym?: string;
}

interface TargetComponent {
    accession?: string;
    target_component_synonyms?: TargetComponentSynonym[];
}

interface RawTarget {
    target_chembl_id?: string;
    pref_name?: string;
    target_type?: string;
    organism?: string;
    target_components?: TargetComponent[];
}

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

function parseNumeric(val: string | number | undefined | null): number | null {
    if (val == null) return null;
    const n = typeof val === "number" ? val : parseFloat(val);
    return Number.isNaN(n) ? null : n;
}

export async function searchTargets(query: string, limit = 25): Promise<ChemblTarget[]> {
    const url = `${CHEMBL_BASE}/target/search.json?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await apiFetch<{ targets?: RawTarget[] }>(url, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }
    return (res.value.targets ?? []).map(mapTarget);
}

export async function getBioactivity(
    chemblId: string,
    type: "compound" | "target",
    options: { activityType?: string; limit?: number } = {},
): Promise<ChemblActivity[]> {
    const limit = options.limit ?? 500;
    const idParam = type === "compound" ? `molecule_chembl_id=${encodeURIComponent(chemblId)}` : `target_chembl_id=${encodeURIComponent(chemblId)}`;
    let url = `${CHEMBL_BASE}/activity.json?${idParam}&limit=${limit}`;
    if (options.activityType) {
        url += `&standard_type=${encodeURIComponent(options.activityType)}`;
    }

    const res = await apiFetch<{ activities?: any[] }>(url, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    return (res.value.activities ?? []).map((raw: any) => ({
        activityId: raw.activity_id != null ? raw.activity_id : null,
        compoundChemblId: raw.molecule_chembl_id ?? "",
        targetChemblId: raw.target_chembl_id ?? null,
        standardType: raw.standard_type ?? null,
        standardValue: parseNumeric(raw.standard_value),
        standardUnits: raw.standard_units ?? null,
        assayChemblId: raw.assay_chembl_id ?? null,
        assayType: raw.assay_type ?? null,
        pchemblValue: parseNumeric(raw.pchembl_value),
    }));
}

async function fetchTargetName(targetChemblId: string): Promise<string | null> {
    const res = await apiFetch<{ pref_name?: string }>(`${CHEMBL_BASE}/target/${targetChemblId}.json`, { headers: HEADERS });
    if (res.isErr() || !res.value.pref_name) return null;
    return res.value.pref_name;
}

export async function getMechanism(chemblId: string): Promise<ChemblMechanism[]> {
    const url = `${CHEMBL_BASE}/mechanism.json?molecule_chembl_id=${encodeURIComponent(chemblId)}`;
    const res = await apiFetch<{ mechanisms?: any[] }>(url, { headers: HEADERS });
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
        batch.forEach((id, idx) => {
            const name = names[idx];
            if (name) targetNames.set(id, name);
        });
    }

    return rawMechanisms.map((raw: any) => ({
        mechanismOfAction: raw.mechanism_of_action ?? null,
        actionType: raw.action_type ?? null,
        targetChemblId: raw.target_chembl_id ?? null,
        targetName: targetNames.get(raw.target_chembl_id ?? "") ?? null,
        moleculeChemblId: raw.molecule_chembl_id ?? "",
    }));
}

interface DrugIndicationRecord {
    mesh_heading?: string;
    efo_term?: string;
}

function extractIndication(indications?: DrugIndicationRecord[]): string | null {
    if (!indications?.length) return null;
    const terms = new Set<string>();
    for (const ind of indications) {
        if (ind.mesh_heading) terms.add(ind.mesh_heading);
        else if (ind.efo_term) terms.add(ind.efo_term);
    }
    return terms.size > 0 ? [...terms].join("; ") : null;
}

export async function getDrugInfo(query: string, limit = 25): Promise<ChemblDrug[]> {
    const drugUrl = `${CHEMBL_BASE}/drug/search.json?q=${encodeURIComponent(query)}&limit=${limit}`;
    const drugRes = await apiFetch<{ drugs?: any[] }>(drugUrl, { headers: HEADERS });

    if (drugRes.isOk() && drugRes.value.drugs?.length) {
        return drugRes.value.drugs.map((raw: any) => ({
            moleculeChemblId: raw.molecule_chembl_id ?? "",
            preferredName: raw.pref_name ?? null,
            maxPhase: raw.max_phase != null ? Number(raw.max_phase) : null,
            moleculeType: raw.molecule_type ?? null,
            firstApproval: raw.first_approval ?? null,
            indication: extractIndication(raw.drug_indications),
        }));
    }

    if (drugRes.isErr() && !(drugRes.error.type === "http_status" && drugRes.error.status === 404)) {
        throw new Error(describeApiError(drugRes.error));
    }

    const molUrl = `${CHEMBL_BASE}/molecule/search.json?q=${encodeURIComponent(query)}&limit=${limit}`;
    const molRes = await apiFetch<{ molecules?: any[] }>(molUrl, { headers: HEADERS });
    if (molRes.isErr()) {
        if (molRes.error.type === "http_status" && molRes.error.status === 404) return [];
        throw new Error(describeApiError(molRes.error));
    }

    const approved = (molRes.value.molecules ?? []).filter((mol: any) => mol.max_phase != null && mol.max_phase >= 4);
    return approved.map((raw: any) => ({
        moleculeChemblId: raw.molecule_chembl_id ?? "",
        preferredName: raw.pref_name ?? null,
        maxPhase: raw.max_phase != null ? Number(raw.max_phase) : null,
        moleculeType: raw.molecule_type ?? null,
        firstApproval: raw.first_approval ?? null,
        indication: null,
    }));
}

/**
 * Fetch all clinical-stage modulators (max_phase ≥ 2 by default) for a target.
 * Used for §2.6.6 (class precedent) and as the input to §2.6.4 (off-target panel).
 */
export async function getTargetModulators(targetChemblId: string, options: { minPhase?: number; limit?: number } = {}): Promise<ChemblModulator[]> {
    const minPhase = options.minPhase ?? 2;
    const limit = options.limit ?? 200;
    const mechUrl = `${CHEMBL_BASE}/mechanism.json?target_chembl_id=${encodeURIComponent(targetChemblId)}` + `&limit=${limit}`;
    const mechRes = await apiFetch<{ mechanisms?: any[] }>(mechUrl, { headers: HEADERS });
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
                const res = await apiFetch<any>(`${CHEMBL_BASE}/molecule/${id}.json`, {
                    headers: HEADERS,
                });
                if (res.isErr()) return null;
                const m = res.value;
                const phase = m.max_phase != null ? Number(m.max_phase) : null;
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
    const res = await apiFetch<{ activities?: any[] }>(url, { headers: HEADERS });
    if (res.isErr()) {
        if (res.error.type === "http_status" && res.error.status === 404) return [];
        throw new Error(describeApiError(res.error));
    }

    const byTarget = new Map<string, ChemblPolypharmHit>();
    for (const raw of res.value.activities ?? []) {
        const tid = raw.target_chembl_id;
        if (!tid) continue;
        if (options.excludeTargetChemblId && tid === options.excludeTargetChemblId) continue;
        const pchembl = parseNumeric(raw.pchembl_value);
        const existing = byTarget.get(tid);
        if (!existing || (pchembl != null && (existing.pchemblValue == null || pchembl > existing.pchemblValue))) {
            byTarget.set(tid, {
                moleculeChemblId,
                targetChemblId: tid,
                targetName: null,
                standardType: raw.standard_type ?? null,
                standardValue: parseNumeric(raw.standard_value),
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
        batch.forEach((id, idx) => {
            const hit = hits.find((h) => h.targetChemblId === id);
            if (hit) hit.targetName = names[idx];
        });
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
    const res = await apiFetch<{ activities?: any[] }>(url, { headers: HEADERS });
    if (res.isErr()) return null;
    const values = (res.value.activities ?? []).map((a: any) => parseNumeric(a.pchembl_value)).filter((v): v is number => v !== null);
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
export async function getModulatorsViaActivity(args: {
    target_chembl_id: string;
    max_phase_min?: number;
    molecule_type?: string;
    limit?: number;
}): Promise<ChemblModulator[]> {
    const { target_chembl_id, max_phase_min = 2, molecule_type, limit = 50 } = args;

    let url = `${CHEMBL_BASE}/activity.json?target_chembl_id=${encodeURIComponent(target_chembl_id)}` + `&max_phase__gte=${max_phase_min}&limit=${limit}`;
    if (molecule_type) {
        url += `&molecule_type=${encodeURIComponent(molecule_type)}`;
    }

    const res = await apiFetch<{ activities?: any[] }>(url, { headers: HEADERS });
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
                const molRes = await apiFetch<any>(`${CHEMBL_BASE}/molecule/${id}.json`, {
                    headers: HEADERS,
                });
                if (molRes.isErr()) return null;
                const m = molRes.value;
                const phase = m.max_phase != null ? Number(m.max_phase) : null;
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
    const res = await apiFetch<{
        molecule_structures?: { standard_inchi_key?: string | null };
    }>(`${CHEMBL_BASE}/molecule/${moleculeChemblId}.json`, { headers: HEADERS });
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
    const mechRes = await apiFetch<{ mechanisms?: Array<{ target_chembl_id?: string }> }>(
        `${CHEMBL_BASE}/mechanism.json?molecule_chembl_id=${encodeURIComponent(moleculeChemblId)}&limit=20`,
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
        const tRes = await apiFetch<{
            target_components?: Array<{ accession?: string; component_type?: string }>;
        }>(`${CHEMBL_BASE}/target/${targetId}.json`, { headers: HEADERS });
        if (tRes.isErr()) continue;
        for (const c of tRes.value.target_components ?? []) {
            if (c.accession && (c.component_type ?? "").toUpperCase() === "PROTEIN") {
                accessions.add(c.accession);
            }
        }
    }
    return [...accessions];
}
