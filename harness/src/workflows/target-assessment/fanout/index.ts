/**
 * Phase-3 fan-out item functions for the harness DBOS workflow.
 *
 * Each function operates on one item (one modulator, one trial, one class
 * drug) and returns a coverage envelope. The DBOS workflow body iterates
 * the item list and dispatches each via `DBOS.runStep` with a deterministic
 * step name `"ta-fanout:{kind}:{itemKey}"`. The `withHost` semaphore inside
 * each body caps openFDA / ChEMBL / ctgov in-flight at 4.
 *
 * No throws — coverage envelope is the failure mode. Recovery replays the
 * cached envelope from the DBOS step cache.
 */

import { withHost } from "../../../lib/host-concurrency.js";

import type { SerializedError } from "../coverage.js";

import { getModulatorOnTargetPchembl, getModulatorPolypharmacology } from "../../../tools/lib/chembl-client.js";
import { getTrialDetails } from "../../../tools/lib/clinical-trials-client.js";
import { getFaersByDrug, getFaersSeriousness } from "../../../tools/lib/openfda-client.js";

import type { ClassDrugItem, PerClassDrugAEsItem } from "../steps/fanout/aes-for-one-class-drug-step.js";
import type { PerTrialAEsItem, TrialItem } from "../steps/fanout/aes-for-one-trial-step.js";
import type { ModulatorItem, PerModulatorFaersItem } from "../steps/fanout/faers-for-one-modulator-step.js";
import type { PerModulatorPolypharmItem, PolypharmInputItem } from "../steps/fanout/polypharm-for-one-modulator-step.js";

export type {
    ClassDrugItem,
    ModulatorItem,
    PerClassDrugAEsItem,
    PerModulatorFaersItem,
    PerModulatorPolypharmItem,
    PerTrialAEsItem,
    PolypharmInputItem,
    TrialItem,
};

type CoverageAvailable<T> = { coverage: "available"; data: T };
type CoverageQueriedNoData = {
    coverage: "queried_no_data";
    error?: SerializedError;
};
type CoverageEnvelope<T> = CoverageAvailable<T> | CoverageQueriedNoData;

function fail(message: string): CoverageQueriedNoData {
    return { coverage: "queried_no_data", error: { message } };
}
function failFromErr(err: unknown): CoverageQueriedNoData {
    return fail(err instanceof Error ? err.message : String(err));
}

// ── Per-modulator FAERS ──────────────────────────────────────────────

export async function faersForOneModulator(item: ModulatorItem): Promise<CoverageEnvelope<PerModulatorFaersItem>> {
    const probe = item.preferredName;
    if (!probe) {
        return fail(`no preferred name for ${item.moleculeChemblId}`);
    }
    try {
        const [byDrug, seriousness] = await Promise.all([
            withHost("openfda", () => getFaersByDrug(probe, { limit: 10 })),
            withHost("openfda", () => getFaersSeriousness(probe)),
        ]);
        const total = byDrug.totalReports ?? 0;
        if (total === 0 && byDrug.adverseEvents.length === 0) {
            return fail(`FAERS returned no reports for ${probe}`);
        }
        if (
            seriousness !== null &&
            seriousness.totalReports >= 1000 &&
            seriousness.fatalCount === 0 &&
            seriousness.hospitalizationCount === 0 &&
            seriousness.lifeThreateningCount === 0 &&
            seriousness.disablingCount === 0 &&
            seriousness.congenitalAnomalyCount === 0 &&
            seriousness.otherSeriousCount === 0
        ) {
            return fail(
                `FAERS seriousness all-zero across ${seriousness.totalReports} reports for ${probe}; openFDA seriousness fields not reliably populated`,
            );
        }
        return {
            coverage: "available",
            data: {
                moleculeChemblId: item.moleculeChemblId,
                preferredName: probe,
                totalReports: byDrug.totalReports ?? null,
                topReactions: byDrug.adverseEvents,
                seriousness,
            },
        };
    } catch (err) {
        return failFromErr(err);
    }
}

// ── Per-modulator polypharmacology ──────────────────────────────────

export async function polypharmForOneModulator(item: PolypharmInputItem): Promise<CoverageEnvelope<PerModulatorPolypharmItem>> {
    try {
        const [hits, primaryPchembl] = await Promise.all([
            withHost("chembl", () =>
                getModulatorPolypharmacology(item.moleculeChemblId, {
                    minPchembl: 5,
                    excludeTargetChemblId: item.primaryTargetChemblId ?? undefined,
                    limit: 200,
                }),
            ),
            item.primaryTargetChemblId
                ? withHost("chembl", () => getModulatorOnTargetPchembl(item.moleculeChemblId, item.primaryTargetChemblId!))
                : Promise.resolve(null),
        ]);
        if (hits.length === 0) {
            return fail(`no polypharm hits for ${item.moleculeChemblId}`);
        }
        return {
            coverage: "available",
            data: {
                moleculeChemblId: item.moleculeChemblId,
                preferredName: item.preferredName,
                primaryPchembl,
                hits: hits.map((h) => ({
                    targetChemblId: h.targetChemblId,
                    targetName: h.targetName,
                    pchemblValue: h.pchemblValue,
                    standardType: h.standardType,
                    standardValue: h.standardValue,
                    standardUnits: h.standardUnits,
                })),
            },
        };
    } catch (err) {
        return failFromErr(err);
    }
}

// ── Per-trial AEs ────────────────────────────────────────────────────

export async function aesForOneTrial(item: TrialItem): Promise<CoverageEnvelope<PerTrialAEsItem>> {
    try {
        const details = await withHost("ctgov", () => getTrialDetails(item.nctId));
        if (!details) {
            return fail(`no details for ${item.nctId}`);
        }
        if (details.adverseEvents.length === 0 && details.outcomes.length === 0) {
            return fail(`no AE/outcome rows for ${item.nctId}`);
        }
        return {
            coverage: "available",
            data: {
                nctId: item.nctId,
                title: item.title,
                whyStopped: details.whyStopped,
                outcomes: details.outcomes,
                groups: details.adverseEventGroups,
                events: details.adverseEvents,
            },
        };
    } catch (err) {
        return failFromErr(err);
    }
}

// ── Per-class-drug AEs ───────────────────────────────────────────────

export async function aesForOneClassDrug(item: ClassDrugItem): Promise<CoverageEnvelope<PerClassDrugAEsItem>> {
    const probe = item.preferredName;
    if (!probe) {
        return fail(`no preferred name for ${item.moleculeChemblId}`);
    }
    try {
        const [byDrug, seriousness] = await Promise.all([
            withHost("openfda", () => getFaersByDrug(probe, { limit: 10 })),
            withHost("openfda", () => getFaersSeriousness(probe)),
        ]);
        const total = byDrug.totalReports ?? 0;
        if (total === 0 && byDrug.adverseEvents.length === 0) {
            return fail(`FAERS returned no reports for ${probe}`);
        }
        return {
            coverage: "available",
            data: {
                moleculeChemblId: item.moleculeChemblId,
                preferredName: probe,
                totalReports: byDrug.totalReports ?? null,
                topReactions: byDrug.adverseEvents,
                seriousness,
            },
        };
    } catch (err) {
        return failFromErr(err);
    }
}
