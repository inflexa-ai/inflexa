/**
 * The noop realization of the `KnowledgeBase` seam. It holds no rules and
 * answers every query with an empty result. An embedder binds it when it
 * wants the knowledge surface present but empty; a composition that binds
 * nothing gets an absent source instead, and the consumers report that
 * condition (the knowledge-base-seam spec).
 */

import { okAsync, type ResultAsync } from "neverthrow";

import type { CorpusIdentity, KnowledgeBase, KnowledgeError, RuleLookup, RuleQueryResult } from "./knowledge-base.js";

const NOOP_CORPUS: CorpusIdentity = { corpusId: "noop", version: "0.0.0" };

export function createNoopKnowledgeBase(): KnowledgeBase {
    return {
        findRules: (): ResultAsync<RuleQueryResult, KnowledgeError> => okAsync({ corpus: NOOP_CORPUS, matches: [] }),
        getRule: (id): ResultAsync<RuleLookup, KnowledgeError> => okAsync({ found: false as const, id }),
        describeCorpus: () => NOOP_CORPUS,
    };
}
