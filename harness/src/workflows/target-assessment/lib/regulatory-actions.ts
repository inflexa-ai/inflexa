/**
 * Per-drug regulatory-action collector. Queries openFDA Structured Product
 * Labels (boxed warning, Section 5 warnings_and_cautions, REMS indicator)
 * and the EMA referrals catalogue (Article 31 / Article 20 procedures)
 * for each drug, then maps both into the dossier's RegulatoryActionRow
 * shape.
 *
 * This is the data-source replacement for the hand-curated calcitonin seed
 * that previously lived next to it. Coverage that legitimately has no
 * machine-readable source (e.g., EMA assessment-report procedure codes like
 * EMEA/H/A-31/1291) is omitted rather than backfilled with curation — the
 * source_url points at the canonical document where the human reader can
 * extract the additional context.
 */

import type { RegulatoryActionRowV5 as RegulatoryActionRow } from "@inflexa-ai/harness/contracts/target-dossier.js";
import { withHost } from "../../../lib/host-concurrency.js";
import { getReferralsByDrug, type EmaReferral } from "../../../tools/lib/ema-client.js";
import { getDrugLabelActions, type DrugLabelAction } from "../../../tools/lib/openfda-client.js";

export interface DrugForRegulatoryActions {
    chemblId: string;
    name: string;
}

function formatEffectiveTime(yyyymmdd: string | null): string {
    if (!yyyymmdd || yyyymmdd.length < 6) return "";
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}`;
}

function formatEmaDate(ddmmyyyy: string): string {
    if (!ddmmyyyy) return "";
    const parts = ddmmyyyy.split("/");
    if (parts.length !== 3) return "";
    return `${parts[2]}-${parts[1]}`;
}

const FINDING_CHAR_LIMIT = 2000;

function clipFinding(text: string): string {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (cleaned.length <= FINDING_CHAR_LIMIT) return cleaned;
    return `${cleaned.slice(0, FINDING_CHAR_LIMIT - 1).trimEnd()}…`;
}

function fdaRowsFor(drug: DrugForRegulatoryActions, labels: DrugLabelAction[]): RegulatoryActionRow[] {
    if (labels.length === 0) return [];
    const sorted = [...labels].sort((a, b) => (b.effectiveTime ?? "").localeCompare(a.effectiveTime ?? ""));
    const latest = sorted[0]!;
    const rows: RegulatoryActionRow[] = [];
    const actionDate = formatEffectiveTime(latest.effectiveTime);

    if (latest.boxedWarning) {
        rows.push({
            drug_chembl_id: drug.chemblId,
            drug_name: drug.name,
            agency: "FDA",
            action_kind: "black_box",
            source_kind: "boxed_warning",
            action_date: actionDate,
            source_date: actionDate,
            application_number: latest.applicationNumber ?? undefined,
            finding: clipFinding(latest.boxedWarning),
            source_url: latest.sourceUrl || undefined,
            evidence: [],
        });
    }
    if (latest.warningsAndCautions) {
        rows.push({
            drug_chembl_id: drug.chemblId,
            drug_name: drug.name,
            agency: "FDA",
            action_kind: "label_warning",
            source_kind: "label_warning",
            action_date: actionDate,
            source_date: actionDate,
            application_number: latest.applicationNumber ?? undefined,
            label_section: "5",
            finding: clipFinding(latest.warningsAndCautions),
            source_url: latest.sourceUrl || undefined,
            evidence: [],
        });
    }
    if (latest.hasRems) {
        rows.push({
            drug_chembl_id: drug.chemblId,
            drug_name: drug.name,
            agency: "FDA",
            action_kind: "REMS",
            source_kind: "rems",
            action_date: actionDate,
            source_date: actionDate,
            application_number: latest.applicationNumber ?? undefined,
            finding: `Risk Evaluation and Mitigation Strategy referenced in current label (${latest.brandName ?? latest.genericName ?? drug.name}).`,
            source_url: latest.sourceUrl || undefined,
            evidence: [],
        });
    }
    return rows;
}

function classifyEmaActionKind(referral: EmaReferral): RegulatoryActionRow["action_kind"] {
    const status = referral.currentStatus.toLowerCase();
    if (status.includes("withdraw")) return "withdrawal";
    return "referral";
}

function emaRowsFor(drug: DrugForRegulatoryActions, referrals: EmaReferral[]): RegulatoryActionRow[] {
    return referrals.map((r) => {
        const date =
            formatEmaDate(r.europeanCommissionDecisionDate) ||
            formatEmaDate(r.chmpOpinionDate) ||
            formatEmaDate(r.cmdhPositionDate) ||
            formatEmaDate(r.pracRecommendationDate) ||
            formatEmaDate(r.procedureStartDate);
        const findingParts: string[] = [];
        if (r.referralType) findingParts.push(r.referralType);
        if (r.referenceNumber) findingParts.push(`(${r.referenceNumber})`);
        if (r.currentStatus) findingParts.push(`— ${r.currentStatus}`);
        if (r.referralName && r.referralName.toLowerCase() !== drug.name.toLowerCase()) {
            findingParts.push(`re: ${r.referralName}`);
        }
        return {
            drug_chembl_id: drug.chemblId,
            drug_name: drug.name,
            agency: "EMA",
            action_kind: classifyEmaActionKind(r),
            source_kind: classifyEmaActionKind(r) === "withdrawal" ? "withdrawal" : "referral",
            action_date: date,
            source_date: date,
            finding: clipFinding(findingParts.join(" ")),
            source_url: r.referralUrl || undefined,
            evidence: [],
        };
    });
}

/**
 * Fetch regulatory actions (FDA label + EMA referrals) for a set of drugs.
 * Per-drug failures are isolated — one drug throwing does not blank out
 * the rest. Returns an empty array when no drugs are provided or no source
 * returned any actions.
 */
export async function fetchRegulatoryActions(drugs: DrugForRegulatoryActions[]): Promise<RegulatoryActionRow[]> {
    if (drugs.length === 0) return [];
    const perDrug = await Promise.all(
        drugs.map(async (drug) => {
            const [fdaLabels, emaReferrals] = await Promise.all([
                withHost("openfda", () => getDrugLabelActions(drug.name)).catch(() => [] as DrugLabelAction[]),
                withHost("ema", () => getReferralsByDrug(drug.name)).catch(() => [] as EmaReferral[]),
            ]);
            return [...fdaRowsFor(drug, fdaLabels), ...emaRowsFor(drug, emaReferrals)];
        }),
    );
    return perDrug.flat();
}
