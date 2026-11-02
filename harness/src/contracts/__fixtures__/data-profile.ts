import type { DataProfileDimension, DataProfileGroup, DataProfileObservation, DataProfilePartition } from "../data-profile.js";

/** The swept residue group of a resolved profile: the files that no operation claimed. */
export function unclassifiedResidueGroup(): DataProfileGroup {
    return {
        id: "unclassified",
        name: "unclassified",
        memberRepresents: "one file no operation claimed",
        description: "Swept residue.",
        role: "data",
        category: "other",
        categoryLabel: "unclassified",
        count: 2,
        fileCount: 2,
        totalBytes: 20,
        displayPattern: "data/inputs",
        formats: [{ format: "txt", count: 2 }],
        unclassified: true,
    };
}

/** The census of the 82-file resolved profile: two groups, one quarantined file. */
export function resolvedProfilePartition(): DataProfilePartition {
    return {
        scannedFiles: 83,
        keptFiles: 82,
        keptMembers: 42,
        groups: 2,
        unclassifiedMembers: 2,
        unclassifiedFiles: 2,
        quarantine: { count: 1, totalBytes: 5, reasons: [{ reason: "os-junk", count: 1 }], sample: ["data/inputs/.DS_Store"] },
    };
}

/** The scan's slot sighting of the subject dimension, bound to the per-subject calls group. */
export function subjectSlotObservation(): DataProfileObservation {
    return {
        kind: "slot",
        groupIds: ["per-subject-calls"],
        slotId: "set-1.slot-1",
        tokenClass: "digits-fixed",
        cardinality: 40,
        sampleValues: ["001"],
    };
}

/** The subject dimension of the resolved profile, over the given observations. */
export function subjectDimension(
    observations: DataProfileObservation[],
    reconciliations?: DataProfileDimension["reconciliations"],
): DataProfileDimension {
    return { label: "subject", category: "subject", scope: "biological", observations, reconciliations };
}
