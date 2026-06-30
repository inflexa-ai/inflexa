import type { EvidenceItem } from "@inflexa-ai/harness/contracts/target-dossier.js";

export type TherapeuticProgramRow = {
    programId: string;
    name: string;
    targetSymbol: string;
    targetUniprot: string | null;
    modality: string;
    sponsor: string | null;
    mechanism: string;
    status: string;
    nctIds: string[];
    pmids: string[];
    evidence: EvidenceItem[];
    confidence: "high" | "medium" | "low";
};

export type TherapeuticProgramTarget = {
    geneSymbol: string;
    uniprot: string | null;
};

const PROGRAM_REGISTRY: TherapeuticProgramRow[] = [
    {
        programId: "AL002",
        name: "AL002",
        targetSymbol: "TREM2",
        targetUniprot: "Q9NZC2",
        modality: "agonistic monoclonal antibody",
        sponsor: "Alector",
        mechanism: "TREM2 agonistic antibody intended to activate microglial TREM2 signaling",
        status: "Phase 2 completed; negative efficacy result reported",
        nctIds: ["NCT03635047", "NCT04592874"],
        pmids: ["39444037", "41787076"],
        confidence: "high",
        evidence: [
            {
                source: "pubmed",
                pmid: "39444037",
                predicate: "phase_1_target_engagement",
                is_human: true,
                is_clinical: true,
            },
            {
                source: "pubmed",
                pmid: "41787076",
                predicate: "phase_2_negative_trial",
                is_human: true,
                is_clinical: true,
            },
            {
                source: "clinicaltrials.gov",
                predicate: "registered_trial",
                metadata: { nct_ids: ["NCT03635047", "NCT04592874"] },
                is_human: true,
                is_clinical: true,
            },
        ],
    },
    {
        programId: "VHB937",
        name: "VHB937",
        targetSymbol: "TREM2",
        targetUniprot: "Q9NZC2",
        modality: "TREM2-stabilizing monoclonal antibody",
        sponsor: "Novartis",
        mechanism: "TREM2 antibody program in early Alzheimer disease",
        status: "Phase 2 recruiting",
        nctIds: ["NCT07094516"],
        pmids: [],
        confidence: "medium",
        evidence: [
            {
                source: "clinicaltrials.gov",
                predicate: "registered_trial",
                metadata: { nct_ids: ["NCT07094516"] },
                is_human: true,
                is_clinical: true,
            },
        ],
    },
];

export function findTherapeuticProgramsForTarget(target: TherapeuticProgramTarget): TherapeuticProgramRow[] {
    const symbol = target.geneSymbol.toUpperCase();
    return PROGRAM_REGISTRY.filter((program) => {
        if (program.targetSymbol.toUpperCase() === symbol) return true;
        return Boolean(target.uniprot && program.targetUniprot === target.uniprot);
    });
}
