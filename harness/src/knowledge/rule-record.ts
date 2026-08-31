/**
 * The rule-record contract of the knowledge plane (the knowledge-rule-records
 * spec). A record is one cited, machine-readable statement of method practice:
 * structured applicability conditions, an effect with a severity, and evidence
 * that resolves to a locator. A record with no resolvable locator fails
 * validation — an uncited rule cannot ground a decision chain.
 *
 * The `applies` condition set is closed on purpose. Every key here is one that
 * the gate can evaluate. An open vocabulary would admit a condition nothing
 * can test, and such a rule silently becomes prose.
 *
 * The set holds data facts only. A rule whose real condition is about the plan,
 * such as "a step optimizes a cutpoint", states that condition in its own
 * statement and leaves `applies` empty. Growing this vocabulary to hold a plan
 * condition is the honest fix, and it belongs to a later change.
 */

import { z } from "zod";

import { extractDoi, extractPmid } from "../citations/normalize.js";

export const RULE_ID_PATTERN = /^INFLEXA-R-\d{6}$/;

// The locator shapes defer to the citations subsystem, thus a locator that
// validates here is one the citation resolver can actually resolve, and the
// two vocabularies cannot drift.
const RuleSourceSchema = z
    .object({
        /** Human-readable reference line, for example "Love MI et al. (2014) Genome Biology". */
        citation: z.string().min(1),
        doi: z
            .string()
            .refine((v) => extractDoi(v) !== undefined, { message: "not a DOI the citation resolver can resolve" })
            .optional(),
        pmid: z
            .string()
            .refine((v) => extractPmid(v) !== undefined, { message: "not a PMID the citation resolver can resolve" })
            .optional(),
        url: z.string().url().optional(),
    })
    .refine((s) => s.doi !== undefined || s.pmid !== undefined || s.url !== undefined, {
        message: "a source must carry a resolvable locator: a doi, a pmid, or a url",
    });

/**
 * Bounds on the smallest per-condition sample count. `lt` and `gte` compose
 * into a half-open range; at least one bound must be present.
 */
const GroupSizePredicateSchema = z
    .strictObject({
        lt: z.number().int().positive().optional(),
        gte: z.number().int().positive().optional(),
    })
    .refine((p) => p.lt !== undefined || p.gte !== undefined, {
        message: "a group-size predicate must carry `lt`, `gte`, or both",
    });

/**
 * The closed condition set. `strictObject` is the closure mechanism: an
 * unknown key fails record validation instead of loading as an untestable
 * condition.
 */
export const RuleAppliesSchema = z.strictObject({
    /** Any-of match against the profile domain, for example "transcriptomics". Case-insensitive. */
    omicsType: z.array(z.string().min(1)).nonempty().optional(),
    /** Any-of match against the profile subtype, for example "bulk-rna-seq". Case-insensitive. */
    omicsSubtype: z.array(z.string().min(1)).nonempty().optional(),
    /** Predicate over the smallest per-condition sample count. */
    minGroupN: GroupSizePredicateSchema.optional(),
});

/**
 * The weight a rule carries, from the strongest to the weakest. No severity
 * blocks a plan: the gate advises on every applicable rule, and the one
 * blocking fault is a citation the source never returned. `reject` names a
 * rule whose violation makes a result unsound, thus its advisory is ranked
 * first and the advisory cap never cuts it.
 */
export const RuleSeveritySchema = z.enum(["reject", "warn", "note"]);

export const RuleRecordSchema = z.strictObject({
    id: z.string().regex(RULE_ID_PATTERN),
    title: z.string().min(1),
    applies: RuleAppliesSchema,
    effect: z.strictObject({
        severity: RuleSeveritySchema,
        /** The rule itself, stated to the planner and the analyst in plain words. */
        statement: z.string().min(1),
    }),
    /** The permitted alternative, when the rule forbids something. */
    recommendation: z.string().min(1).optional(),
    evidence: z.strictObject({
        /** Evidence Ontology class for how the assertion is supported. */
        eco: z
            .string()
            .regex(/^ECO:\d{7}$/)
            .optional(),
        sources: z.array(RuleSourceSchema).nonempty(),
    }),
    version: z.string().min(1),
    supersedes: z.string().regex(RULE_ID_PATTERN).optional(),
});

/**
 * The corpus manifest. `ruleFiles` is the closed load list — a rule file the
 * manifest does not name does not load, thus the corpus content is exactly
 * what the manifest declares. The manifest is deliberately NOT strict: an
 * unknown key from a newer corpus version is ignored, because one added field
 * must not turn the whole knowledge plane off for an older harness. The
 * record schema stays strict — its closure is the evaluability guarantee.
 */
export const CorpusManifestSchema = z.object({
    corpusId: z.string().min(1),
    version: z.string().min(1),
    ruleFiles: z.array(z.string().min(1)).nonempty(),
});

export type RuleSource = z.infer<typeof RuleSourceSchema>;
export type RuleApplies = z.infer<typeof RuleAppliesSchema>;
export type RuleSeverity = z.infer<typeof RuleSeveritySchema>;
export type RuleRecord = z.infer<typeof RuleRecordSchema>;
export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;
