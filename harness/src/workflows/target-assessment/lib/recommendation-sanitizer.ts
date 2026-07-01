import type { DossierRecommendationOutput } from "../synthesis/index.js";

/**
 * Strip pipeline scaffold tokens from user-visible recommendation prose.
 *
 * The Phase-5 dossier-recommendation agent occasionally echoes internal
 * indexing paths it saw in its delegation prompt — strings like
 * `per_section_synthesis.liability_bullets[0]` and parenthetical lists
 * containing them. These are scaffolding for the build pipeline; a
 * toxicologist reading the final dossier should never see them.
 *
 * The sanitizer removes the tokens and their parenthetical wrappers,
 * collapses the resulting double whitespace, and preserves surrounding
 * sentence punctuation.
 */

const SCAFFOLD_TOKEN_RE = /per_section_synthesis\.[A-Za-z_][\w.]*(?:\[[\d–-]+\])?(?:\s+row\s+\d+)?/g;

// Citations to dossier.per_section_synthesis.* — this namespace doesn't exist
// in the v4 schema. The synthesis prompt occasionally emits these paths;
// strip them to prevent non-resolvable citations in recommendation prose.
const INVALID_PATH_RE = /\(?dossier\.per_section_synthesis\.[a-z_.\[\]0-9]*\)?/gi;
// Dangling "dossier." with no path suffix is leftover templating; strip it.
const DANGLING_DOSSIER_RE = /\bdossier\.(?=\s|$|[.,;])/g;

function stripScaffold(text: string): string {
    if (!text) return text;
    let out = text;
    // First pass: remove a parenthetical that contains a scaffold token,
    // along with its trailing punctuation if it directly precedes one.
    out = out.replace(/\s*\([^()]*per_section_synthesis\.[^()]*\)/g, "");
    // Second pass: any leftover scaffold tokens not inside parens.
    out = out.replace(SCAFFOLD_TOKEN_RE, "");
    // Strip dossier.per_section_synthesis.* invalid paths and dangling dossier. placeholders.
    out = out.replace(INVALID_PATH_RE, "").replace(DANGLING_DOSSIER_RE, "");
    // Collapse double whitespace.
    out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1");
    return out.trim();
}

export function sanitizeRecommendation(rec: DossierRecommendationOutput): DossierRecommendationOutput {
    return {
        ...rec,
        rationale: stripScaffold(rec.rationale),
        key_strengths: rec.key_strengths.map(stripScaffold),
        key_risks: rec.key_risks.map(stripScaffold),
        modality_choice: {
            ...rec.modality_choice,
            rationale: stripScaffold(rec.modality_choice.rationale),
        },
        coverage_qualifier: {
            ...rec.coverage_qualifier,
            note: stripScaffold(rec.coverage_qualifier.note),
        },
    };
}
