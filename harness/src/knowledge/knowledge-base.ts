/**
 * The `KnowledgeBase` capability seam (the knowledge-base-seam spec).
 *
 * The harness declares the interface, and it never branches on which
 * realization is bound. Phase 1 ships two local realizations: the noop and
 * the file-backed corpus reader. A remote knowledge service binds here later
 * with no harness change.
 *
 * Absence is a normal condition. The composition can resolve NO knowledge
 * source, and each consumer (the planner brief, the knowledge tools, the
 * grounded plan gate) then reports that condition as data. Thus `err` is
 * reserved for an unexpected failure of a bound source, never for absence,
 * and never for "no matching rule".
 */

import type { ResultAsync } from "neverthrow";

import type { AgentSession } from "../auth/types.js";
import type { DomainError } from "../lib/result.js";
import type { KnowledgeFacts, RuleApplicability } from "./evaluate-rule.js";
import type { RuleRecord } from "./rule-record.js";

export type { KnowledgeFacts, RuleApplicability } from "./evaluate-rule.js";

/** The corpus identity a consumer records beside each consultation. */
export interface CorpusIdentity {
    readonly corpusId: string;
    readonly version: string;
}

/**
 * One returned rule. `not_applicable` rules are filtered out before the
 * return — a consumer sees the rules that constrain this dataset (`applies`)
 * and the rules that might (`not_evaluable`), never the ones that do not.
 */
export interface RuleMatch {
    readonly rule: RuleRecord;
    readonly applicability: Exclude<RuleApplicability, "not_applicable">;
}

export interface RuleQuery {
    /** Dataset facts to evaluate each rule's conditions against. */
    readonly facts?: KnowledgeFacts;
    /** Keyword filter over id, title, statement, and recommendation. */
    readonly text?: string;
    /** Result cap. The realization applies its own default and ceiling. */
    readonly topK?: number;
}

export interface RuleQueryResult {
    readonly corpus: CorpusIdentity;
    readonly matches: readonly RuleMatch[];
}

/** Absence of the id is a data variant, in the house error contract. */
export type RuleLookup = { readonly found: true; readonly corpus: CorpusIdentity; readonly rule: RuleRecord } | { readonly found: false; readonly id: string };

/** The unexpected-failure channel of a bound source (a remote outage, a torn read). */
export interface KnowledgeError extends DomainError {
    readonly type: "knowledge_unavailable";
    readonly detail: string;
}

export interface KnowledgeBase {
    /**
     * Find the rules that constrain, or might constrain, the described data.
     * The `session` rides for the same reason it does on `ArtifactRegistry`:
     * a remote realization addresses its service under the caller's auth.
     */
    findRules(query: RuleQuery, session: AgentSession): ResultAsync<RuleQueryResult, KnowledgeError>;
    /** Read one full rule by id. An unknown id is a data variant. */
    getRule(id: string, session: AgentSession): ResultAsync<RuleLookup, KnowledgeError>;
    /** The corpus identity and version, for the brief header and the observation. */
    describeCorpus(): CorpusIdentity;
}
