/**
 * The referential and the content gates over a loaded knowledge base.
 *
 * The schema gate says that each record has the right shape. This gate says
 * that the records agree with each other: every reference resolves, every
 * condition names a Situation field or the engine-derived field
 * `inferential_method`, every method scope of a parameter resolves and holds
 * the method of its rule, every adaptable slot of a template has a marked
 * line, every body placeholder is a declared slot, every template that a
 * method with its own template lists runs that method or names it in
 * `substitute_for`, every substitute names a method of record that shares a
 * step type, every
 * template that runs a test between groups declares the design requirements
 * it honors, every count-model template that a transcript quantifier can feed
 * either imports the quantifications or excludes the import states that
 * carry lengths, and every claim id is unique. With `--resolve-dois` the gate
 * also asks the DOI resolver for each DOI and each PMID, because a citation
 * that exists is the floor of a citation that supports.
 *
 * Run: `bun src/build/validate.ts [--resolve-dois]`
 */

import { join } from "node:path";

import { claimId, contentDigest } from "../canonical.js";
import { SituationSchema, type KnowledgeBase, type StepType, type Template } from "../model.js";
import { bodySlotNames, unmarkedAdaptableSlots } from "../render/render.js";
import { loadKnowledgeBase } from "./load-kb.js";

export interface ValidationIssue {
    readonly where: string;
    readonly message: string;
}

/**
 * The fields a rule condition can name: every Situation slot (thus `classifier`
 * and `import_state` too), plus `inferential_method`. That field is not a
 * Situation slot: the engine derives it from the method of the inferential step
 * and a caller cannot set it.
 */
const SITUATION_FIELDS = new Set([...Object.keys(SituationSchema.shape), "inferential_method"]);

/** The step types whose script can run a test between the groups of the sample table. */
const GROUP_TEST_STEPS = new Set<StepType>(["differential_expression", "enrichment", "tf_activity", "pathway_activity", "signature_scoring", "deconvolution", "coexpression", "survival", "variance_partition"]);

/**
 * Whether a template runs a test between groups, and thus must declare the design
 * requirements it honors. Three facts of the template say so: one of its step types
 * is a group-test step type, its inputs name the sample table (an input named
 * `metadata`), and it asks for replication (`min_replicates` absent or at least 2).
 * An over-representation or a preranked test reads a results table and no sample
 * table. A descriptive comparison without replicates runs no test.
 */
function runsGroupTest(template: Template): boolean {
    if (!template.step_types.some((step) => GROUP_TEST_STEPS.has(step))) return false;
    if (!(template.inputs ?? []).some((input) => input.name === "metadata")) return false;
    const replicates = template.applicability.min_replicates;
    return replicates === undefined || replicates >= 2;
}

/** The count sources whose output is a transcript estimate: a count table from one of them has an import state. */
const QUANTIFIER_SOURCES = new Set<string>(["salmon", "kallisto", "rsem"]);

/** The import states whose input carries the average transcript lengths, thus the input is not an integer CSV. */
const IMPORT_STATES_WITH_LENGTHS = ["quantifications", "estimated_counts_with_lengths"] as const;

/**
 * Whether a template realizes the count model on the output of a transcript
 * quantifier, and thus must say what it does with the quantification states:
 * it names the `model_design` step, and its `count_sources` list a quantifier.
 * A template that reads a results table or a per-sample score never imports
 * the counts, whatever its `count_sources` say.
 */
function modelsQuantifierCounts(template: Template): boolean {
    if (!template.step_types.includes("model_design")) return false;
    return (template.applicability.count_sources ?? []).some((source) => QUANTIFIER_SOURCES.has(source));
}

/** Whether the template imports the quantifications itself: it declares the transcript-to-gene slot. */
function importsQuantifications(template: Template): boolean {
    return template.parameters.some((parameter) => parameter.name === "tx2gene_path");
}

/** Whether the template excludes every import state that carries lengths with one `import_state not_in [...]` condition. */
function excludesLengthStates(template: Template): boolean {
    return (template.applicability.conditions ?? []).some((condition) => {
        if (condition.field !== "import_state" || condition.op !== "not_in" || !Array.isArray(condition.value)) return false;
        const excluded = condition.value;
        return IMPORT_STATES_WITH_LENGTHS.every((state) => excluded.includes(state));
    });
}

/**
 * The step types of each method: the step types of the templates whose `method` is
 * the method, plus the step type of each rule whose action selects it. A substitute
 * must share one of them with its method of record.
 */
function stepTypesByMethod(kb: KnowledgeBase): Map<string, Set<StepType>> {
    const byMethod = new Map<string, Set<StepType>>();
    const add = (method: string, step: StepType): void => {
        const steps = byMethod.get(method) ?? new Set<StepType>();
        steps.add(step);
        byMethod.set(method, steps);
    };
    for (const template of kb.templates) for (const step of template.step_types) add(template.method, step);
    for (const rule of kb.rules) if (rule.action.method) add(rule.action.method, rule.action.step_type);
    return byMethod;
}

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
        // A method with no template of its own (a filter, a normalization) is realized inside the
        // templates of other methods, and it lists them. A method with its own template that lists a
        // template of a different method asks that template to stand in for it, and the template must say so.
        const own = kb.templates.some((template) => template.method === method.id);
        for (const id of method.templates ?? []) {
            const template = templates.get(id);
            if (!template) {
                issues.push({ where: `method ${method.id}`, message: `names an unknown template ${id}` });
                continue;
            }
            if (own && template.method !== method.id && template.substitute_for !== method.id) {
                issues.push({ where: `method ${method.id}`, message: `lists the template ${id} of the method ${template.method}, and the template does not name ${method.id} in substitute_for` });
            }
        }
    }
    const stepTypes = stepTypesByMethod(kb);

    const claims = new Map<string, string>();
    for (const rule of kb.rules) {
        const where = `rule ${rule.id}`;
        for (const condition of rule.conditions ?? []) {
            if (!SITUATION_FIELDS.has(condition.field)) issues.push({ where, message: `condition names an unknown Situation field ${condition.field}` });
            if ((condition.op === "in" || condition.op === "not_in" || condition.op === "contains") && !Array.isArray(condition.value)) issues.push({ where, message: `condition ${condition.field} ${condition.op} needs a list value` });
            if ((condition.op === "is_null" || condition.op === "not_null") && condition.value !== undefined) issues.push({ where, message: `condition ${condition.field} ${condition.op} takes no value` });
        }
        if (rule.action.method && !methods.has(rule.action.method)) issues.push({ where, message: `action names an unknown method ${rule.action.method}` });
        for (const parameter of rule.action.parameters ?? []) {
            for (const scoped of parameter.methods ?? []) {
                if (!methods.has(scoped)) issues.push({ where, message: `parameter ${parameter.name} names an unknown method ${scoped}` });
            }
            // A scope that leaves out the method of its own rule would never reach the step that rule selects.
            if (parameter.methods && rule.action.method && !parameter.methods.includes(rule.action.method)) {
                issues.push({ where, message: `parameter ${parameter.name} scopes to ${parameter.methods.join(", ")} but not to the method of the rule ${rule.action.method}` });
            }
        }
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
        if (template.substitute_for !== undefined) {
            const record = template.substitute_for;
            if (record === template.method) issues.push({ where, message: `substitute_for names the own method ${record}` });
            else if (!methods.has(record)) issues.push({ where, message: `substitute_for names an unknown method ${record}` });
            else if (!template.step_types.some((step) => stepTypes.get(record)?.has(step))) issues.push({ where, message: `substitute_for names ${record}, and no template or rule of that method shares a step type with this template` });
        }
        if (runsGroupTest(template) && template.applicability.honors === undefined) issues.push({ where, message: "runs a test between groups and must declare applicability.honors (an empty list declares that the script honors no design requirement)" });
        // An integer-CSV template that a quantifier can feed would receive a quantification state it cannot read.
        if (modelsQuantifierCounts(template) && !importsQuantifications(template) && !excludesLengthStates(template)) {
            issues.push({ where, message: `lists a transcript quantifier in count_sources and must either declare a tx2gene_path slot or carry the condition import_state not_in [${IMPORT_STATES_WITH_LENGTHS.join(", ")}]` });
        }
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
