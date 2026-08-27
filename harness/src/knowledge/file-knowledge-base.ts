/**
 * The file-backed realization of the `KnowledgeBase` seam. It loads a local
 * corpus — a manifest plus the rule files the manifest names — one time at
 * construction, validates each record, and serves every read from memory.
 *
 * The load discipline (the knowledge-base-seam spec): a missing or invalid
 * manifest refuses construction with a typed error, because there is no
 * corpus identity to serve under. An invalid record, a duplicate id, or an
 * unreadable rule file is excluded and reported through the injected
 * `Logger`, and the valid records still load — one bad record must not sink
 * the corpus.
 */

import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";

import { createNoopLogger } from "../lib/console-logger.js";
import { classifyWithinRoot } from "../lib/fs-helpers.js";
import type { Logger } from "../lib/logger.js";
import { evaluateRule, type KnowledgeFacts } from "./evaluate-rule.js";
import type { CorpusIdentity, KnowledgeBase, KnowledgeError, RuleLookup, RuleMatch, RuleQuery, RuleQueryResult } from "./knowledge-base.js";
import { CorpusManifestSchema, RuleRecordSchema, type RuleRecord } from "./rule-record.js";

const DEFAULT_TOP_K = 20;
const MAX_TOP_K = 50;

export interface KnowledgeCorpusError {
    readonly type: "knowledge_corpus_unreadable";
    readonly dir: string;
    readonly detail: string;
    readonly cause?: unknown;
}

export interface FileKnowledgeBaseDeps {
    /** Absolute path of the corpus directory (holds `manifest.json`). */
    readonly dir: string;
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
}

/**
 * Whole-token AND match. A substring OR would let a short token match inside
 * unrelated words and would broaden a multi-word query, and the top-K window
 * then fills with rules the query never asked for.
 */
function matchesText(rule: RuleRecord, text: string): boolean {
    const queryTokens = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    if (queryTokens.length === 0) return true;
    const haystack = new Set(
        [rule.id, rule.title, rule.effect.statement, rule.recommendation ?? ""]
            .join(" ")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean),
    );
    return queryTokens.every((t) => haystack.has(t));
}

const SEVERITY_RANK: Record<RuleRecord["effect"]["severity"], number> = { reject: 0, warn: 1, note: 2 };

/** `applies` before `not_evaluable`, then by severity, then by id for a stable order. */
function compareMatches(a: RuleMatch, b: RuleMatch): number {
    if (a.applicability !== b.applicability) return a.applicability === "applies" ? -1 : 1;
    const bySeverity = SEVERITY_RANK[a.rule.effect.severity] - SEVERITY_RANK[b.rule.effect.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.rule.id.localeCompare(b.rule.id);
}

/**
 * Load the corpus and construct the realization. The read of every rule file
 * happens here, one time — the returned instance does no I/O on a query.
 */
export function loadFileKnowledgeBase(deps: FileKnowledgeBaseDeps): ResultAsync<KnowledgeBase, KnowledgeCorpusError> {
    const logger = (deps.logger ?? createNoopLogger()).named("knowledge.corpus");
    const refuse = (detail: string, cause?: unknown): ResultAsync<KnowledgeBase, KnowledgeCorpusError> =>
        errAsync({ type: "knowledge_corpus_unreadable" as const, dir: deps.dir, detail, ...(cause === undefined ? {} : { cause }) });

    const load = async (): Promise<ResultAsync<KnowledgeBase, KnowledgeCorpusError>> => {
        let manifestRaw: string;
        try {
            manifestRaw = await readFile(join(deps.dir, "manifest.json"), "utf8");
        } catch (cause) {
            return refuse("manifest.json is not readable", cause);
        }
        let manifestJson: unknown;
        try {
            manifestJson = JSON.parse(manifestRaw);
        } catch (cause) {
            return refuse("manifest.json is not valid JSON", cause);
        }
        const manifest = CorpusManifestSchema.safeParse(manifestJson);
        if (!manifest.success) {
            return refuse(`manifest.json fails validation: ${manifest.error.issues.map((i) => i.message).join("; ")}`);
        }

        const corpus: CorpusIdentity = { corpusId: manifest.data.corpusId, version: manifest.data.version };
        const rules = new Map<string, RuleRecord>();

        const corpusRoot = resolve(deps.dir);
        // A root that already ends in the separator is the filesystem root, and
        // concatenating a second separator would exclude every rule file.
        const rootPrefix = corpusRoot.endsWith(sep) ? corpusRoot : corpusRoot + sep;
        for (const ruleFile of manifest.data.ruleFiles) {
            // Confinement in two stages, and both are necessary. A manifest is
            // data, thus a `../` entry must not read outside the corpus. The
            // lexical test catches that with no I/O, but path resolution does not
            // follow a symlink — so a link planted inside the corpus would still
            // read a file outside it, and its records would load as trusted rules
            // whose text reaches the planner seed. `classifyWithinRoot` is the
            // symlink-following companion the workspace read seam already uses
            // against the same threat. A target equal to the root names the
            // directory itself, which is not a rule file.
            const target = resolve(corpusRoot, ruleFile);
            if (target === corpusRoot || !target.startsWith(rootPrefix)) {
                logger.warn("rule file excluded — the path resolves outside the corpus directory", { ruleFile });
                continue;
            }
            let verdict;
            try {
                verdict = await classifyWithinRoot(corpusRoot, target);
            } catch (err) {
                logger.warn("rule file excluded — the path could not be classified against the corpus root", { ruleFile, ...logger.errorFields(err) });
                continue;
            }
            if (verdict === "escaped") {
                logger.warn("rule file excluded — a symlink resolves outside the corpus directory", { ruleFile });
                continue;
            }
            let fileJson: unknown;
            try {
                fileJson = JSON.parse(await readFile(target, "utf8"));
            } catch (err) {
                logger.warn("rule file excluded — not readable as JSON", { ruleFile, ...logger.errorFields(err) });
                continue;
            }
            if (!Array.isArray(fileJson)) {
                logger.warn("rule file excluded — the content is not an array of records", { ruleFile });
                continue;
            }
            for (const [index, candidate] of fileJson.entries()) {
                const parsed = RuleRecordSchema.safeParse(candidate);
                if (!parsed.success) {
                    logger.warn("rule record excluded — validation failed", {
                        ruleFile,
                        index,
                        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5),
                    });
                    continue;
                }
                if (rules.has(parsed.data.id)) {
                    logger.warn("rule record excluded — duplicate id, the first record wins", { ruleFile, id: parsed.data.id });
                    continue;
                }
                rules.set(parsed.data.id, parsed.data);
            }
        }

        logger.info("knowledge corpus loaded", { corpusId: corpus.corpusId, version: corpus.version, ruleCount: rules.size });

        const kb: KnowledgeBase = {
            findRules: (query: RuleQuery): ResultAsync<RuleQueryResult, KnowledgeError> => {
                const facts: KnowledgeFacts = query.facts ?? {};
                const matches: RuleMatch[] = [];
                for (const rule of rules.values()) {
                    const applicability = evaluateRule(rule, facts);
                    if (applicability === "not_applicable") continue;
                    if (query.text !== undefined && !matchesText(rule, query.text)) continue;
                    matches.push({ rule, applicability });
                }
                matches.sort(compareMatches);
                const topK = Math.min(query.topK ?? DEFAULT_TOP_K, MAX_TOP_K);
                return okAsync({ corpus, matches: matches.slice(0, topK) });
            },
            getRule: (id: string): ResultAsync<RuleLookup, KnowledgeError> => {
                const rule = rules.get(id);
                return okAsync(rule === undefined ? { found: false as const, id } : { found: true as const, corpus, rule });
            },
            describeCorpus: () => corpus,
        };
        return okAsync(kb);
    };

    return fromPromise(load(), (cause): KnowledgeCorpusError => ({
        type: "knowledge_corpus_unreadable",
        dir: deps.dir,
        detail: "corpus load failed",
        cause,
    })).andThen((result) => result);
}
