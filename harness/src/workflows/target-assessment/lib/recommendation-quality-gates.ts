import type { ExecutiveRecommendation, QualityGateStatus, RecommendationAudit, SynthesisDiagnosticRow } from "@inflexa-ai/harness/contracts/target-dossier.js";

type ApplyRecommendationQualityGatesInput = {
    executive_recommendation: ExecutiveRecommendation;
    synthesis_diagnostics: Array<Partial<SynthesisDiagnosticRow> & { step_id?: string }>;
    recommendation_audit: Extract<RecommendationAudit, { coverage: "available" }>["data"] | null | undefined;
    has_direct_clinical_evidence: boolean;
};

type ApplyRecommendationQualityGatesResult = {
    executive_recommendation: ExecutiveRecommendation;
    quality_gates: QualityGateStatus[];
};

const ORGAN_CLAIM_RE =
    /\b(renal|kidney|nephro\w*|cns|brain|hypothalam\w*|cardiac|cardiovascular|hepatic|liver|pulmonary|respiratory|gastrointestinal|gi|oncology|malignan\w*)\b/i;

function appendNote(current: string, addition: string): string {
    const trimmed = current.trim();
    return trimmed ? `${trimmed} ${addition}` : addition;
}

export function applyRecommendationQualityGates(input: ApplyRecommendationQualityGatesInput): ApplyRecommendationQualityGatesResult {
    const quality_gates: QualityGateStatus[] = [];
    const executive_recommendation = structuredClone(input.executive_recommendation);

    const unresolved = input.recommendation_audit?.citations_unresolved ?? [];
    const visibleRecommendationText =
        input.executive_recommendation.coverage === "available"
            ? [
                  input.executive_recommendation.data.rationale,
                  input.executive_recommendation.data.modality_choice.rationale,
                  ...input.executive_recommendation.data.key_strengths,
                  ...input.executive_recommendation.data.key_risks,
              ].join("\n")
            : "";
    const blockingCitationCount = unresolved.filter((u: { surface: string; excerpt?: unknown }) => {
        // The unresolved-citation entries are an untyped audit payload narrowed
        // here to the fields these gates read; `excerpt` exists only on some
        // surfaces, guarded by the `in` presence check.
        if (u.surface === "organ_claim_without_probe_pass" && "excerpt" in u) {
            const excerpt = String(u.excerpt ?? "");
            return excerpt.length > 0 && visibleRecommendationText.includes(excerpt.slice(0, Math.min(80, excerpt.length)));
        }
        return ["external_missing", "nct_wrong_class", "organ_claim_without_probe_pass", "off_topic_citation"].includes(u.surface);
    }).length;
    if (blockingCitationCount > 0) {
        quality_gates.push({
            gate_id: "recommendation-citations",
            status: "blocked",
            message: "Recommendation contains unresolved or unsafe citation references.",
            affected_sections: ["executive_recommendation"],
            unresolved_count: blockingCitationCount,
        });
        return {
            executive_recommendation: {
                coverage: "queried_no_data",
                error: {
                    message: "executive recommendation blocked because unresolved citation audit findings remain",
                    source: "recommendation-quality-gates",
                },
            },
            quality_gates,
        };
    }

    const safetyFlags = input.synthesis_diagnostics.find((row) => row.step_id === "safety-flags-trail");
    const safetyFlagsAvailable = safetyFlags?.final_coverage === "available";
    if (!safetyFlagsAvailable && executive_recommendation.coverage === "available") {
        const rec = executive_recommendation.data;
        const unverified = rec.key_risks
            .filter((risk) => ORGAN_CLAIM_RE.test(risk))
            .map((risk) => ({
                text: risk,
                bullet_category: "organ_claim_without_probe_pass",
                surface: "organ_claim_without_probe_pass" as const,
            }));
        if (unverified.length > 0) {
            rec.key_risks = rec.key_risks.filter((risk) => !ORGAN_CLAIM_RE.test(risk));
            rec.coverage_qualifier = {
                ...rec.coverage_qualifier,
                unverified_bullets: [...(rec.coverage_qualifier.unverified_bullets ?? []), ...unverified],
                note: appendNote(
                    rec.coverage_qualifier.note,
                    "Organ-level risk bullets were demoted because the safety-flags audit trail did not pass validation.",
                ),
            };
            quality_gates.push({
                gate_id: "safety-flags-trail",
                status: "blocked",
                message: "Organ-level executive risk claims were demoted because safety-flags-trail was unavailable or failed validation.",
                affected_sections: ["executive_recommendation.key_risks"],
                unresolved_count: unverified.length,
            });
        }
    }

    if (!input.has_direct_clinical_evidence && executive_recommendation.coverage === "available") {
        const rec = executive_recommendation.data;
        if (rec.confidence !== "low") {
            rec.confidence = "low";
        }
        rec.coverage_qualifier = {
            ...rec.coverage_qualifier,
            note: appendNote(
                rec.coverage_qualifier.note,
                "No direct target-modulator clinical evidence was available; recommendation confidence is capped at low.",
            ),
        };
        quality_gates.push({
            gate_id: "direct-clinical-evidence",
            status: "warning",
            message: "No direct target-modulator clinical evidence is available, so confidence is capped at low.",
            affected_sections: ["executive_recommendation"],
        });
    }

    if (!quality_gates.some((g) => g.status === "blocked")) {
        quality_gates.push({
            gate_id: "recommendation-quality",
            status: "pass",
            message: "No blocking recommendation quality issues detected.",
            affected_sections: ["executive_recommendation"],
        });
    }

    return { executive_recommendation, quality_gates };
}
