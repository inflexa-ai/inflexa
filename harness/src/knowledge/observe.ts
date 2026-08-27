/**
 * The consultation observation of the knowledge seam. The composition wraps
 * the resolved source one time; each successful read then reports one event
 * to the host callback. The contract copies `UsageRecorder`: the callback is
 * fire-and-forget — it must not throw and must not block, and the harness
 * never awaits it. A throwing callback is contained here and logged, thus an
 * observation fault can never fail a consultation.
 */

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { KnowledgeBase } from "./knowledge-base.js";
import type { CorpusIdentity } from "./knowledge-base.js";

export interface KnowledgeConsultation {
    /** Which read produced the event. */
    readonly kind: "find_rules" | "get_rule";
    readonly corpus: CorpusIdentity;
    /** The rule identifiers the read returned. */
    readonly ruleIds: readonly string[];
    /** The consulting agent, from the session provenance. */
    readonly agentId: string;
}

export type ObserveKnowledge = (event: KnowledgeConsultation) => void;

export interface KnowledgeObservationDeps {
    readonly observe: ObserveKnowledge;
    readonly logger?: Logger;
}

export function withKnowledgeObservation(kb: KnowledgeBase, deps: KnowledgeObservationDeps): KnowledgeBase {
    const logger = (deps.logger ?? createNoopLogger()).named("knowledge.observe");
    const report = (event: KnowledgeConsultation): void => {
        try {
            deps.observe(event);
        } catch (err) {
            logger.warn("knowledge observation callback threw — event dropped", logger.errorFields(err));
        }
    };

    return {
        findRules: (query, session) =>
            kb.findRules(query, session).map((result) => {
                report({
                    kind: "find_rules",
                    corpus: result.corpus,
                    ruleIds: result.matches.map((m) => m.rule.id),
                    agentId: session.provenance.agentId,
                });
                return result;
            }),
        getRule: (id, session) =>
            kb.getRule(id, session).map((result) => {
                report({
                    kind: "get_rule",
                    corpus: result.found ? result.corpus : kb.describeCorpus(),
                    ruleIds: result.found ? [result.rule.id] : [],
                    agentId: session.provenance.agentId,
                });
                return result;
            }),
        describeCorpus: () => kb.describeCorpus(),
    };
}
