// The recommendation agent emits citations as `[dossier: path; path; …]`
// blocks (colon-space, semicolon-separated), sometimes with a trailing
// `external citation: id; id` segment inside the same bracket. The old
// `dossier.path` regex never matched this in production — citations_total
// was always 0. These patterns match the format the agent actually writes.
// The block content may include array index notation like `[0]`, so we
// use a pattern that allows `[digits]` inside the outer brackets.
const DOSSIER_CITE_BLOCK_RE = /\[dossier:\s*((?:[^[\]]*(?:\[\d+\])?)*)\]/gi;
// External citation IDs are plain strings — no array-index notation like `[n]` — so the simple [^\]]+ class suffices here instead of the array-index-aware pattern used by DOSSIER_CITE_BLOCK_RE.
const EXTERNAL_CITE_BLOCK_RE = /\[external citation:\s*([^\]]+)\]/gi;
// Assumes at most one `external citation:` segment per dossier block (the recommendation prompt produces at most one); a hypothetical second segment in the same block would be parsed imperfectly.
const EXTERNAL_SEGMENT_RE = /external citation:\s*((?:[^[\]]*(?:\[\d+\])?)*)/i;
const NCT_RE = /\bNCT\d{8}\b/g;
const PMID_RE = /\bPMID[:\s]?(\d{6,9})\b/g;

// Legacy inline format: `dossier.path.foo` written directly in prose, no
// brackets. Still emitted by some recommendation outputs and exercised by
// the regression fixtures, so BOTH this and the `[dossier: …]` block format
// must be supported. This pattern only matches a bare `dossier.x.y` token —
// inside a `[dossier: …]` block the word `dossier` is followed by `:`, not
// `.`/`[`, so the two are disjoint and never double-count.
const DOSSIER_PATH_RE = /\bdossier(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+/g;
// Legacy bare external reference: `[ANDA215864]` — an all-caps id in
// brackets. Disjoint from `[dossier: …]` / `[external citation: …]` blocks
// (those start with a lowercase word) and from `[0]` array indices (digits).
const EXTERNAL_ID_RE = /\[([A-Z]{2,}[A-Z0-9_-]+)\]/g;

// Path prefixes the agent uses that are NOT part of the persisted dossier
// body — they refer to the per-section synthesis inputs the agent was
// shown. Citing them is legitimate; resolving them against the dossier is
// not, so they go to `non_dossier_citations` instead of `unresolved`.
const NON_DOSSIER_PREFIXES = ["per_section_synthesis"];

const ORGAN_CATEGORIES = new Set(["high_safety_organ_expression", "broad_expression", "class_liability"]);

/**
 * Keyword fallback for detecting organ-level claims when the bullet has
 * no structural `category` field (the production
 * DossierRecommendationOutputSchema types key_risks as z.array(z.string())
 * with no category metadata, so a category check alone would be dead
 * code). Matches the regression-test approach in
 * [C4] of calcr-target-assessment.test.ts.
 */
const ORGAN_KEYWORDS_RE =
    /\b(kidney|kidneys|renal|nephro\w*|cns|central\s+nervous|brain|hypothalam\w*|cardiac|cardiovascular|hepatic|liver|hepato\w*|pulmonary|respiratory|gastrointestinal)\b/i;

/**
 * Bullet-keyword → canonical organ class. The keys mirror the alternatives
 * in `ORGAN_KEYWORDS_RE`; values match `target_organ_liabilities[i].organ`,
 * which the assembler emits using the canonical safety-panel set
 * (`cardiac` | `cns` | `hepatic` | `renal` | `gi` | `respiratory` | ...).
 *
 * Used to cross-match an organ-level key_risk bullet against the TOL probe
 * pass without depending on the bullet text containing the literal JSON
 * path `dossier.safety_profile.target_organ_liabilities` — LLM bullets are
 * plain English so the path-based check from earlier never matched in
 * production.
 */
const BULLET_KEYWORD_TO_ORGAN: Array<{ rx: RegExp; organ: string }> = [
    { rx: /\b(kidney|kidneys|renal|nephro\w*)\b/i, organ: "renal" },
    { rx: /\b(cns|central\s+nervous|brain|hypothalam\w*)\b/i, organ: "cns" },
    { rx: /\b(cardiac|cardiovascular)\b/i, organ: "cardiac" },
    { rx: /\b(hepatic|liver|hepato\w*)\b/i, organ: "hepatic" },
    { rx: /\b(pulmonary|respiratory)\b/i, organ: "respiratory" },
    { rx: /\b(gastrointestinal)\b/i, organ: "gi" },
];

function extractOrganClassesFromText(text: string): Set<string> {
    const result = new Set<string>();
    for (const { rx, organ } of BULLET_KEYWORD_TO_ORGAN) {
        if (rx.test(text)) result.add(organ);
    }
    return result;
}

export type RecommendationAuditEntry =
    | { surface: "rationale" | "key_strengths" | "key_risks" | "modality_choice"; path: string; excerpt: string }
    | { surface: "external_missing"; id: string; excerpt: string }
    | { surface: "organ_claim_without_probe_pass"; excerpt: string; bullet_category: string }
    | { surface: "nct_wrong_class"; id: string; excerpt: string }
    | { surface: "pmid_not_in_key_papers"; id: string; excerpt: string };

export type RecommendationAudit = {
    citations_total: number;
    citations_unresolved: RecommendationAuditEntry[];
    non_dossier_citations: Array<{ token: string; source: string }>;
};

type KeyRiskLike = { text: string; category?: string } | string;

type RecLike = {
    rationale: string;
    key_strengths: KeyRiskLike[];
    key_risks: KeyRiskLike[];
    modality_choice: { rationale: string };
    external_citations?: Array<{ id: string }>;
};

// Loose structural view over a raw dossier. Every field is optional and each
// section wraps its payload as `{ coverage?, data? }`; this names only the
// fields the citation checks read. `resolvePath` walks the body generically
// (path strings), so it keeps `unknown`; the structured collectors below use
// this view. The public entrypoint accepts `unknown` and casts to it.
type Section<T> = { coverage?: string; data?: T };

type TrialRow = {
    nct_id?: unknown;
    interventions?: unknown[];
    armsInterventionsModule?: { interventions?: unknown[] };
};

type CitationDossierView = {
    drug_interactions?: Section<{ rows?: Array<{ drug_name?: unknown }> }>;
    reference_biology?: { key_papers?: Section<{ rows?: Array<{ pmid?: unknown }> }> };
    clinical_development?: {
        trials?: Section<{ rows?: TrialRow[] }>;
        failed_trials?: Section<{ rows?: TrialRow[] }>;
    };
    analytics?: { discovery_trials?: Section<{ rows?: TrialRow[] }> };
    safety_profile?: { target_organ_liabilities?: Array<{ organ?: unknown }> };
};

function resolvePath(root: unknown, path: string): unknown {
    if (!path.startsWith("dossier")) return undefined;
    const stripped = path.replace(/^dossier\.?/, "");
    if (stripped === "") return root;
    const parts = stripped.split(/\.|\[(\d+)\]/).filter(Boolean);
    return walkWithDataFallback(root, parts);
}

function walkWithDataFallback(root: unknown, parts: string[]): unknown {
    let cur: unknown = root;
    for (const p of parts) {
        if (cur == null) return undefined;
        const next = readPart(cur, p);
        if (next !== undefined) {
            cur = next;
            continue;
        }
        // The dossier wraps every section as { coverage, data: {...} }. When a
        // lookup misses and the current node has a `data` child, descend through
        // it transparently — the LLM consistently writes paths without the wrapper
        // (e.g. "translational_chain.peak_evidence_tier" instead of
        // "translational_chain.data.peak_evidence_tier"). This mirrors how a human
        // reader refers to the field; flagging it as unresolved produces noise.
        if (typeof cur === "object" && "data" in cur) {
            const viaData = readPart((cur as Record<string, unknown>).data, p);
            if (viaData !== undefined) {
                cur = viaData;
                continue;
            }
        }
        return undefined;
    }
    return cur;
}

function readPart(node: unknown, p: string): unknown {
    if (node == null) return undefined;
    if (/^\d+$/.test(p)) return Array.isArray(node) ? node[parseInt(p, 10)] : undefined;
    return typeof node === "object" ? (node as Record<string, unknown>)[p] : undefined;
}

/**
 * Extract dossier-path citations from `text`, supporting two formats:
 *   - New `[dossier: path; path]` blocks — `;`-separated bare paths, a
 *     trailing `/ID-list` suffix dropped, `external citation:` segment
 *     excluded (picked up by `findExternalIds`).
 *   - Legacy inline `dossier.path.foo` tokens written directly in prose.
 *
 * Returns `{ path, resolvable }` pairs: `path` is what surfaces in an
 * unresolved-citation entry (bare for block tokens, `dossier.`-prefixed for
 * legacy tokens — matching what each format's callers expect); `resolvable`
 * is always `dossier.`-prefixed so `resolvePath` can walk it.
 */
function findPathTokens(text: string): Array<{ path: string; resolvable: string }> {
    const tokens: Array<{ path: string; resolvable: string }> = [];
    // New `[dossier: …]` block format.
    for (const block of text.matchAll(DOSSIER_CITE_BLOCK_RE)) {
        const dossierPart = block[1]!.split(/external citation:/i)[0]!;
        for (const raw of dossierPart.split(";")) {
            const token = raw.trim().split("/")[0]!.trim();
            if (token.length > 0) tokens.push({ path: token, resolvable: `dossier.${token}` });
        }
    }
    // Legacy inline `dossier.path.foo` format. The match already carries the
    // `dossier.` prefix — keep it in `path` (callers expect the prefixed form
    // for this format) and use it directly as `resolvable`.
    for (const m of text.matchAll(DOSSIER_PATH_RE)) {
        tokens.push({ path: m[0], resolvable: m[0] });
    }
    return tokens;
}

/**
 * Extract external-citation ids. The agent writes them either as a
 * standalone `[external citation: id; id]` block or as a trailing segment
 * inside a `[dossier: …; external citation: id]` block.
 */
function findExternalIds(text: string): string[] {
    const ids: string[] = [];
    const push = (segment: string) => {
        for (const raw of segment.split(";")) {
            const id = raw.trim();
            if (id.length > 0) ids.push(id);
        }
    };
    for (const block of text.matchAll(EXTERNAL_CITE_BLOCK_RE)) push(block[1]!);
    for (const block of text.matchAll(DOSSIER_CITE_BLOCK_RE)) {
        const m = block[1]!.match(EXTERNAL_SEGMENT_RE);
        if (m) push(m[1]!);
    }
    // Legacy bare `[UPPERCASE_ID]` external reference (e.g. `[ANDA215864]`).
    // NCT and PMID references in bracket form are already handled by NCT_RE /
    // PMID_RE in the main loop — skip them here to avoid double-processing.
    for (const m of text.matchAll(EXTERNAL_ID_RE)) {
        const id = m[1]!;
        if (/^NCT\d/.test(id) || /^PMID\d/.test(id)) continue;
        ids.push(id);
    }
    return ids;
}

function normaliseBullet(b: KeyRiskLike): { text: string; category?: string } {
    return typeof b === "string" ? { text: b } : { text: b.text, category: b.category };
}

function collectClassDrugNames(dossier: CitationDossierView): Set<string> {
    const rows = dossier?.drug_interactions?.data?.rows ?? [];
    return new Set(rows.map((r) => String(r.drug_name ?? "").toUpperCase()).filter(Boolean));
}

function collectKeyPaperPmids(dossier: CitationDossierView): Set<string> {
    const rows = dossier?.reference_biology?.key_papers?.data?.rows ?? [];
    return new Set(rows.map((r) => String(r.pmid)).filter(Boolean));
}

/**
 * Extract intervention names from a trial row. Handles two shapes:
 * - Flat `interventions: string[]` — the production dossier shape assembled by
 *   `partitionTrialsByAttribution`.
 * - Nested `armsInterventionsModule.interventions: Array<{ name: string }>` — the
 *   raw CT.gov v2 JSON shape that may appear in test fixtures or future collector
 *   output before the assembler flattens it.
 */
function extractInterventionNames(row: TrialRow): string[] {
    // Production flat shape (priority)
    if (Array.isArray(row.interventions)) {
        return row.interventions.map((iv) => (typeof iv === "string" ? iv.toUpperCase() : String((iv as { name?: unknown })?.name ?? "").toUpperCase()));
    }
    // Raw CT.gov nested shape fallback
    const nested = row?.armsInterventionsModule?.interventions;
    if (Array.isArray(nested)) {
        return nested.map((iv) => String((iv as { name?: unknown })?.name ?? "").toUpperCase());
    }
    return [];
}

function findTrialInterventions(dossier: CitationDossierView, nctId: string): string[] {
    const trialSets: TrialRow[][] = [
        dossier?.clinical_development?.trials?.data?.rows ?? [],
        dossier?.clinical_development?.failed_trials?.data?.rows ?? [],
        dossier?.analytics?.discovery_trials?.data?.rows ?? [],
    ];
    for (const set of trialSets) {
        const row = set.find((t) => t.nct_id === nctId);
        if (!row) continue;
        return extractInterventionNames(row);
    }
    return [];
}

export function validateRecommendationCitations(rec: RecLike, dossier: unknown): RecommendationAudit {
    const dossierView = dossier as CitationDossierView;
    const unresolved: RecommendationAuditEntry[] = [];
    const nonDossier: Array<{ token: string; source: string }> = [];
    let total = 0;
    const externalIds = new Set((rec.external_citations ?? []).map((c) => c.id));

    const surfaces: Array<{ surface: "rationale" | "key_strengths" | "key_risks" | "modality_choice"; text: string }> = [
        { surface: "rationale", text: rec.rationale },
        { surface: "modality_choice", text: rec.modality_choice.rationale },
        ...rec.key_strengths.map((b) => ({ surface: "key_strengths" as const, text: normaliseBullet(b).text })),
        ...rec.key_risks.map((b) => ({ surface: "key_risks" as const, text: normaliseBullet(b).text })),
    ];

    const classDrugNames = collectClassDrugNames(dossierView);
    const keyPmids = collectKeyPaperPmids(dossierView);

    for (const { surface, text } of surfaces) {
        for (const { path, resolvable } of findPathTokens(text)) {
            total += 1;
            // Legacy-format tokens carry a `dossier.` prefix; block-format tokens
            // are bare. Strip the prefix so the non-dossier-prefix check works for
            // both formats.
            const barePath = path.startsWith("dossier.") ? path.slice("dossier.".length) : path;
            if (NON_DOSSIER_PREFIXES.some((p) => barePath === p || barePath.startsWith(`${p}.`) || barePath.startsWith(`${p}[`))) {
                nonDossier.push({ token: path, source: surface });
                continue;
            }
            const resolved = resolvePath(dossier, resolvable);
            if (resolved === undefined || resolved === null) {
                unresolved.push({ surface, path, excerpt: text.slice(0, 200) });
            }
        }
        for (const id of findExternalIds(text)) {
            if (!externalIds.has(id)) {
                unresolved.push({ surface: "external_missing", id, excerpt: text.slice(0, 200) });
            }
        }
        for (const m of text.matchAll(NCT_RE)) {
            const nctId = m[0];
            const interventions = findTrialInterventions(dossierView, nctId);
            // Only flag wrong-class when the trial IS present in the dossier
            // and its interventions don't reference the class. Trials absent
            // from the collected sets are unverifiable — flagging them would
            // produce false positives for any on-class trial that the
            // synthesis agent cited but the discovery collector missed.
            if (interventions.length === 0) continue;
            // Skip when no class-drug catalog is available — without a reference
            // set (early-stage / first-in-class targets, or drug_interactions
            // collector returning queried_no_data) every cited trial would
            // otherwise flag as wrong-class regardless of its actual class.
            if (classDrugNames.size === 0) continue;
            const referencesClassDrug = interventions.some((iv) => [...classDrugNames].some((name) => iv.includes(name)));
            if (!referencesClassDrug) {
                unresolved.push({ surface: "nct_wrong_class", id: nctId, excerpt: text.slice(0, 200) });
            }
        }
        for (const m of text.matchAll(PMID_RE)) {
            const pmid = m[1]!;
            if (!keyPmids.has(pmid)) {
                unresolved.push({ surface: "pmid_not_in_key_papers", id: pmid, excerpt: text.slice(0, 200) });
            }
        }
    }

    const organLiabilities = dossierView?.safety_profile?.target_organ_liabilities ?? [];
    const tolOrgans = new Set(
        organLiabilities
            .map((t) =>
                String(t?.organ ?? "")
                    .toLowerCase()
                    .trim(),
            )
            .filter((o: string) => o.length > 0),
    );
    for (const b of rec.key_risks ?? []) {
        const norm = normaliseBullet(b);
        // Detect organ-level claims by structural category when available
        // (typed bullets) OR by keyword match on the text (plain-string
        // bullets — the production shape).
        const isOrganClaim = (norm.category != null && ORGAN_CATEGORIES.has(norm.category)) || ORGAN_KEYWORDS_RE.test(norm.text);
        if (!isOrganClaim) continue;
        // "Probe pass" = the TOL section has an entry whose organ matches the
        // organ class mentioned in the bullet. Production bullets are plain
        // English so we extract the organ class via keyword matching and
        // cross-reference against the canonical TOL organ field.
        const bulletOrgans = extractOrganClassesFromText(norm.text);
        const citesTOL = bulletOrgans.size > 0 && [...bulletOrgans].some((o) => tolOrgans.has(o));
        if (!citesTOL) {
            unresolved.push({
                surface: "organ_claim_without_probe_pass",
                excerpt: norm.text.slice(0, 200),
                bullet_category: norm.category ?? "inferred_from_text",
            });
        }
    }

    return {
        citations_total: total,
        citations_unresolved: unresolved,
        non_dossier_citations: nonDossier,
    };
}
