/**
 * The referential and the content gates over a loaded knowledge base.
 *
 * The schema gate says that each record has the right shape. This gate says
 * that the records agree with each other: every reference resolves, every
 * condition names a Situation field, every adaptable slot of a template has a
 * marked line, every body placeholder is a declared slot, and every claim id
 * is unique. With `--resolve-dois` the gate also asks the DOI resolver for
 * each DOI and each PMID, because a citation that exists is the floor of a
 * citation that supports.
 *
 * Run: `bun src/build/validate.ts [--resolve-dois]`
 */

import { join } from "node:path";

import { claimId, contentDigest } from "../canonical.js";
import { SituationSchema, type KnowledgeBase } from "../model.js";
import { bodySlotNames, unmarkedAdaptableSlots } from "../render/render.js";
import { loadKnowledgeBase } from "./load-kb.js";

export interface ValidationIssue {
    readonly where: string;
    readonly message: string;
}

const SITUATION_FIELDS = new Set(Object.keys(SituationSchema.shape));

export function validateKnowledgeBase(kb: KnowledgeBase): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const sources = new Set(kb.sources.map((source) => source.id));
    const methods = new Set(kb.methods.map((method) => method.id));
    const templates = new Map(kb.templates.map((template) => [template.id, template]));
    const rules = new Set(kb.rules.map((rule) => rule.id));

    const duplicates = <T extends { readonly id: string }>(items: readonly T[], kind: string): void => {
        const seen = new Set<string>();
        for (const item of items) {
            if (seen.has(item.id)) issues.push({ where: `${kind} ${item.id}`, message: "duplicate id" });
            seen.add(item.id);
        }
    };
    duplicates(kb.sources, "source");
    duplicates(kb.methods, "method");
    duplicates(kb.rules, "rule");
    duplicates(kb.templates, "template");

    for (const source of kb.sources) {
        if (!source.doi && !source.pmid && !source.url) issues.push({ where: `source ${source.id}`, message: "a source needs a DOI, a PMID, or a URL" });
    }

    for (const method of kb.methods) {
        for (const template of method.templates ?? []) {
            if (!templates.has(template)) issues.push({ where: `method ${method.id}`, message: `names an unknown template ${template}` });
        }
    }

    const claims = new Map<string, string>();
    for (const rule of kb.rules) {
        const where = `rule ${rule.id}`;
        for (const condition of rule.conditions ?? []) {
            if (!SITUATION_FIELDS.has(condition.field)) issues.push({ where, message: `condition names an unknown Situation field ${condition.field}` });
            if ((condition.op === "in" || condition.op === "not_in" || condition.op === "contains") && !Array.isArray(condition.value)) issues.push({ where, message: `condition ${condition.field} ${condition.op} needs a list value` });
            if ((condition.op === "is_null" || condition.op === "not_null") && condition.value !== undefined) issues.push({ where, message: `condition ${condition.field} ${condition.op} takes no value` });
        }
        if (rule.action.method && !methods.has(rule.action.method)) issues.push({ where, message: `action names an unknown method ${rule.action.method}` });
        for (const forbidden of rule.action.forbids ?? []) {
            if (!methods.has(forbidden)) issues.push({ where, message: `forbids an unknown method ${forbidden}` });
        }
        for (const alternative of rule.alternatives ?? []) {
            if (!methods.has(alternative.method)) issues.push({ where, message: `alternative names an unknown method ${alternative.method}` });
        }
        for (const side of rule.disputed_sides ?? []) {
            if (side.method && !methods.has(side.method)) issues.push({ where, message: `disputed side names an unknown method ${side.method}` });
        }
        if (rule.strength === "disputed" && (rule.disputed_sides?.length ?? 0) < 2) issues.push({ where, message: "a disputed rule needs at least two sides" });
        if (rule.severity === "flag" && rule.action.method !== undefined && rule.action.outcome === undefined) issues.push({ where, message: "a flag rule that names a method must also name the permitted outcome" });
        if (rule.severity === "info" && rule.action.method === undefined && (rule.action.parameters?.length ?? 0) === 0) issues.push({ where, message: "an info rule must select a method or set a parameter" });
        for (const line of rule.evidence) {
            if (!sources.has(line.source)) issues.push({ where, message: `evidence names an unknown source ${line.source}` });
            if (!line.paraphrase && !line.span) issues.push({ where, message: `evidence from ${line.source} needs a paraphrase or a span` });
        }
        if (rule.supersedes && !rules.has(rule.supersedes)) issues.push({ where, message: `supersedes an unknown rule ${rule.supersedes}` });
        if (rule.replaced_by && !rules.has(rule.replaced_by)) issues.push({ where, message: `replaced by an unknown rule ${rule.replaced_by}` });
        if (rule.status === "deprecated" && !rule.replaced_by) issues.push({ where, message: "a deprecated rule needs a replaced_by link" });
        const claim = claimId(rule.id, contentDigest(rule));
        if (claims.has(claim)) issues.push({ where, message: `claim id ${claim} collides with ${claims.get(claim)}` });
        claims.set(claim, rule.id);
    }

    for (const template of kb.templates) {
        const where = `template ${template.id}`;
        if (!methods.has(template.method)) issues.push({ where, message: `names an unknown method ${template.method}` });
        for (const citation of template.citations ?? []) {
            if (!sources.has(citation)) issues.push({ where, message: `cites an unknown source ${citation}` });
        }
        const declared = new Set(template.parameters.map((parameter) => parameter.name));
        for (const name of bodySlotNames(template.body)) {
            if (!declared.has(name)) issues.push({ where, message: `the body references an undeclared slot ${name}` });
        }
        for (const parameter of template.parameters) {
            if (!bodySlotNames(template.body).has(parameter.name)) issues.push({ where, message: `the slot ${parameter.name} is declared but the body never uses it` });
            if (!parameter.adaptable && parameter.default === undefined) issues.push({ where, message: `the pinned slot ${parameter.name} needs a default` });
            if (!parameter.adaptable && !parameter.default_source) issues.push({ where, message: `the pinned slot ${parameter.name} needs a default_source` });
        }
        for (const slot of unmarkedAdaptableSlots(template, template.body)) issues.push({ where, message: `the adaptable slot ${slot} has no line marked [adaptable: ${slot}]` });
        for (const test of template.tests ?? []) {
            for (const name of Object.keys(test.slots)) {
                if (!declared.has(name)) issues.push({ where: `${where} test ${test.name}`, message: `sets an undeclared slot ${name}` });
            }
        }
    }

    for (const modality of kb.modalities) {
        for (const [question, steps] of Object.entries(modality.question_steps)) {
            for (const step of steps) {
                if (!modality.step_order.includes(step)) issues.push({ where: `modality ${modality.id}`, message: `question ${question} names a step ${step} outside the step order` });
            }
        }
    }

    return issues;
}

async function resolveLocator(url: string): Promise<boolean> {
    const response = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    return response !== undefined && response.ok;
}

/** Ask the resolvers whether every DOI and PMID exists. Network only; polite spacing between calls. */
export async function resolveSources(kb: KnowledgeBase): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    for (const source of kb.sources) {
        if (source.doi) {
            const ok = await resolveLocator(`https://doi.org/api/handles/${encodeURIComponent(source.doi)}`);
            if (!ok) issues.push({ where: `source ${source.id}`, message: `the DOI ${source.doi} does not resolve` });
            await Bun.sleep(350);
        } else if (source.pmid) {
            const ok = await resolveLocator(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${source.pmid}&retmode=json`);
            if (!ok) issues.push({ where: `source ${source.id}`, message: `the PMID ${source.pmid} does not resolve` });
            await Bun.sleep(350);
        }
    }
    return issues;
}

if (import.meta.main) {
    const root = join(import.meta.dir, "..", "..", "kb");
    const loaded = await loadKnowledgeBase(root);
    if (!loaded.ok) {
        for (const issue of loaded.issues) console.error(`${issue.path}: ${issue.message}`);
        process.exit(1);
    }
    const issues = validateKnowledgeBase(loaded.kb);
    if (process.argv.includes("--resolve-dois")) issues.push(...(await resolveSources(loaded.kb)));
    for (const issue of issues) console.error(`${issue.where}: ${issue.message}`);
    const counts = `${loaded.kb.rules.length} rules, ${loaded.kb.methods.length} methods, ${loaded.kb.templates.length} templates, ${loaded.kb.sources.length} sources, ${loaded.kb.terms.length} terms`;
    if (issues.length > 0) {
        console.error(`validation failed with ${issues.length} issue(s) over ${counts}`);
        process.exit(1);
    }
    console.log(`validation passed: ${counts}`);
}
