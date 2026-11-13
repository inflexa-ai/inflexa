/**
 * The methods and the sources of one step, as the host builds them after the agent loop. The input is
 * the grounding of the plan step, the claim views that the plan kept, and the host copies of the decision
 * records that `knowledge_template` wrote. The agent does not write the block: the host holds these
 * facts as data, and a summary in prose can drop them.
 *
 * No agent writes the host copies, but the service and the model give their content. Thus each read is
 * confined against a symlink, bounded in size and in count, and parsed as untrusted data. A record that
 * does not parse is left out, and the grounding still gives the claims and their evidence.
 */

import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join, posix as posixPath } from "node:path";
import { z } from "zod";

import type { PlanStepDeparture, StepMethods, StepMethodsClaim, StepMethodsSource, StepMethodsTemplate } from "../contracts/chat-parts.js";
import { citationKey } from "../contracts/report-reference.js";
import { classifyWithinRoot, computeSha256 } from "../lib/fs-helpers.js";
import { errnoOf } from "../lib/fs-result.js";
import type { Logger } from "../lib/logger.js";
import type { ProvenanceCollector } from "../provenance/collector.js";
import { landWithinRoot } from "../tools/workspace/mutator.js";
import { safeParseJsonAs } from "../lib/parse-json.js";
import type { ClaimView, Grounding } from "../schemas/workflow-state.js";

/** Claims carried in the methods of one step. The tail is counted. */
export const MAX_METHODS_CLAIMS = 60;

/** Sources carried in the methods of one step. The tail is counted. */
export const MAX_METHODS_SOURCES = 60;

/** Departures carried in the methods of one step. The tail is counted. */
export const MAX_METHODS_DEPARTURES = 30;

/** Record files read for one step. A step renders one script for each record. */
const MAX_RECORD_FILES = 16;

/** Bytes of one record file. A real record holds about 10 KB. */
const MAX_RECORD_BYTES = 256 * 1024;

const RECORD_PREFIX = "decision_record_";
const RECORD_SUFFIX = ".json";

/** The part of a decision record that the methods read. The service and the tool add other fields. */
const DecisionRecordSchema = z.looseObject({
    template: z.looseObject({
        id: z.string(),
        version: z.string(),
        label: z.string(),
        method: z.looseObject({ id: z.string(), label: z.string() }),
    }),
    snapshot: z.looseObject({ digest: z.string() }).optional(),
    claims: z.array(z.looseObject({ claim: z.string(), title: z.string().optional() })).optional(),
    citations: z
        .array(
            z.looseObject({
                doi: z.string().optional(),
                pmid: z.string().optional(),
                url: z.string().optional(),
                title: z.string(),
                year: z.number().optional(),
            }),
        )
        .optional(),
    environment: z.looseObject({ match: z.string() }).optional(),
    script_path: z.string().optional(),
    /** The digest of the script that the render wrote. */
    written_sha256: z.string().optional(),
    /**
     * The slots that the script read, with the value of each. A step that fits the same model again takes them.
     * A value of a different shape reads as no value, thus one such slot does not remove the record from the methods.
     */
    slots: z
        .array(
            z.looseObject({
                name: z.string(),
                value: z
                    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
                    .optional()
                    .catch(undefined),
            }),
        )
        .optional(),
    /** One entry for each change of the script after the render. With an entry, the slots can differ from the script that ran. */
    unvetted_edits: z.array(z.looseObject({ sha256: z.string().optional() })).optional(),
    /**
     * One entry for each run of the script through `execute_command`. A list of a different shape reads as no run,
     * thus such a record stays in the methods and gives no slot value to a second fit.
     */
    runs: z
        .array(z.looseObject({ exit_code: z.number().nullable().optional().catch(undefined), sha256: z.string().optional().catch(undefined) }))
        .optional()
        .catch(undefined),
});

/**
 * True when the record holds a run of the bytes that the render wrote, and the command of that run ended with exit
 * code 0. A render that never ran gave no result, and a run of changed bytes read values that the record does not hold.
 */
export function recordHasRenderedRun(record: StepDecisionRecord): boolean {
    if (record.written_sha256 === undefined) return false;
    return (record.runs ?? []).some((run) => run.exit_code === 0 && run.sha256 === record.written_sha256);
}
export type StepDecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** One decision record that parsed, and its file relative to the step directory (`output/<name>`). */
export type ReadDecisionRecord = {
    readonly file: string;
    readonly record: StepDecisionRecord;
};

/** The names of the record files in `dir`, in name order. An absent directory gives no name. */
async function recordFileNames(dir: string): Promise<string[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return [];
    }
    return names.filter((name) => name.startsWith(RECORD_PREFIX) && name.endsWith(RECORD_SUFFIX)).sort();
}

/** The largest script that the digest check of a record reads. */
const MAX_RECORD_SCRIPT_BYTES = 4 * 1024 * 1024;

/**
 * True when the script of `record` in `stepDir` (the host directory of the step) holds the bytes that the render
 * wrote. A script that a file tool did not change can still differ: a shell command can write it, and the record
 * then lists no change. An absent script, a script outside the step, and a record with no digest give false.
 */
export async function recordScriptIsAsRendered(stepDir: string, record: StepDecisionRecord): Promise<boolean> {
    const relative = stepScriptPath(record.script_path);
    if (relative === undefined || record.written_sha256 === undefined) return false;
    const path = join(stepDir, relative);
    try {
        if ((await classifyWithinRoot(stepDir, path)) !== "in") return false;
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_RECORD_SCRIPT_BYTES) return false;
        return computeSha256(await readFile(path)) === record.written_sha256;
    } catch {
        return false;
    }
}

/**
 * The count of the record files of a step in `recordDir`, or `undefined` when the directory is there and the read of
 * it failed. An absent directory gives 0. `readStepDecisionRecords` reads a bounded count of the files, and it
 * leaves out a file that does not parse. A caller that needs each record compares the two counts.
 */
export async function countStepDecisionRecordFiles(recordDir: string): Promise<number | undefined> {
    try {
        const names = await readdir(recordDir);
        return names.filter((name) => name.startsWith(RECORD_PREFIX) && name.endsWith(RECORD_SUFFIX)).length;
    } catch (err) {
        return errnoOf(err) === "ENOENT" ? 0 : undefined;
    }
}

/**
 * Read the decision records of a step from `recordDir`, the host copies of its `output/decision_record_*.json`
 * (`stepDecisionRecordDir`), in the order of the file names. Each entry names the copy in the step. A file that
 * escapes the directory, that is too large, or that does not parse is left out with a warning. An absent directory
 * gives no record.
 */
export async function readStepDecisionRecords(recordDir: string, logger: Logger): Promise<ReadDecisionRecord[]> {
    const records: ReadDecisionRecord[] = [];
    for (const name of (await recordFileNames(recordDir)).slice(0, MAX_RECORD_FILES)) {
        const path = join(recordDir, name);
        try {
            if ((await classifyWithinRoot(recordDir, path)) !== "in") {
                logger.warn("a decision record is not inside the record directory of the step, thus the methods leave it out", { file: name });
                continue;
            }
            const info = await stat(path);
            if (!info.isFile() || info.size > MAX_RECORD_BYTES) {
                logger.warn("a decision record is not a file of the permitted size, thus the methods leave it out", { file: name, size: info.size });
                continue;
            }
            const parsed = safeParseJsonAs(await readFile(path, "utf8"), DecisionRecordSchema);
            if (!parsed.success) {
                logger.warn("a decision record does not parse, thus the methods leave it out", { file: name });
                continue;
            }
            records.push({ file: `output/${name}`, record: parsed.data });
        } catch (err) {
            logger.warn("a decision record read failed, thus the methods leave it out", { file: name, ...logger.errorFields(err) });
        }
    }
    return records;
}

/**
 * Write the copy in `output/` of the step again for each host copy in `recordDir` that the step does not hold
 * byte for byte, because an agent can remove or change the files of its step. The restore takes each host copy, also
 * past the bound of the methods. Each copy that it writes again gets a warning. A copy that it cannot write gets a
 * warning too, and the step continues.
 */
export async function restoreStepDecisionRecords(args: {
    readonly recordDir: string;
    readonly writePrefix: string;
    readonly stagingKey: string;
    /** The lineage collector of the step. Each copy that equals its host copy keeps only a producer of those bytes. */
    readonly collector?: ProvenanceCollector;
    readonly logger: Logger;
}): Promise<void> {
    for (const name of await recordFileNames(args.recordDir)) {
        const hostPath = join(args.recordDir, name);
        const copyPath = join(args.writePrefix, "output", name);
        try {
            if ((await classifyWithinRoot(args.recordDir, hostPath)) !== "in") continue;
            const info = await stat(hostPath);
            if (!info.isFile() || info.size > MAX_RECORD_BYTES) continue;
            const bytes = await readFile(hostPath);
            const copy = await lstat(copyPath).catch(() => undefined);
            const equal = copy?.isFile() === true && copy.size === bytes.length && bytes.equals(await readFile(copyPath));
            if (!equal) {
                const landed = await landWithinRoot({ root: args.writePrefix, absolute: copyPath, content: bytes, stagingKey: args.stagingKey });
                if (landed !== "ok") {
                    args.logger.warn("the copy of a decision record in the step is absent or changed, and the host cannot write it again", {
                        file: `output/${name}`,
                        status: landed,
                    });
                    continue;
                }
                args.logger.warn("the copy of a decision record in the step was absent or changed, thus the host wrote it again", { file: `output/${name}` });
            }
            if (args.collector) keepProducerOfBytes(args.collector, `output/${name}`, computeSha256(bytes));
        } catch (err) {
            args.logger.warn("a decision record restore failed", { file: `output/${name}`, ...args.logger.errorFields(err) });
        }
    }
}

/**
 * Keep the provenance record of `path` only when a file tool wrote exactly `hash` there. Any other producer, for
 * example the command that removed or changed the copy, did not write the bytes on disk. Thus its record goes, and
 * the file falls to the step. The rule reads only the collector and the bytes, thus a replay gives the same result.
 */
function keepProducerOfBytes(collector: ProvenanceCollector, path: string, hash: string): void {
    const current = collector.getRecords().find((record) => record.outputPath === path);
    if (current === undefined) return;
    if (current.producer.type === "file_tool" && current.outputHash === hash) return;
    collector.removeRecord(path);
}

/**
 * The views of the claims that a grounding cites, in the order of the grounding. A view matches on the
 * claim id and on the snapshot digest of the grounding, because a claim id names a claim of one release
 * only. A claim with no view is absent here.
 */
export function claimViewsOfGrounding(grounding: Grounding | undefined, views: readonly ClaimView[]): ClaimView[] {
    if (!grounding) return [];
    return grounding.claims.flatMap((id) => views.find((view) => view.id === id && view.snapshot === grounding.snapshot) ?? []);
}

/**
 * The citation key of a source in the prefixed `idKind:id` form: `doi:` in lower case, else `pmid:`.
 * A source with only a URL or a title has no key, because a citation reference names no such id kind.
 */
export function citationKeyOfSource(source: StepMethodsSource): string | undefined {
    if (source.doi) return citationKey("doi", source.doi);
    if (source.pmid) return citationKey("pmid", source.pmid);
    return undefined;
}

/** The key of a source: its DOI, else its PubMed id, else its URL, else its title. */
function sourceKey(source: StepMethodsSource): string {
    if (source.doi) return `doi:${source.doi.toLowerCase()}`;
    if (source.pmid) return `pmid:${source.pmid}`;
    if (source.url) return `url:${source.url}`;
    return `title:${source.title.toLowerCase()}`;
}

/** A script path inside the step directory: `scripts/<file>` for a path under `scripts/`. */
function stepScriptPath(scriptPath: string | undefined): string | undefined {
    if (!scriptPath) return undefined;
    return `scripts/${posixPath.basename(scriptPath)}`;
}

/**
 * Build the methods of a step. The claims are the claims of the grounding, then the claims of the
 * records that the grounding does not cite. A view gives the title and the strength of a claim, else a
 * record gives its title. The sources are the citations of the records, then the evidence of the views,
 * one entry for each DOI, PubMed id, or URL. The departures are the departures of the grounding. Gives
 * `undefined` when the step has no grounding, no claim, and no record.
 */
export function buildStepMethods(args: StepMethodsInput): StepMethods | undefined {
    return assembleStepMethods(args)?.methods;
}

type StepMethodsInput = {
    readonly grounding?: Grounding;
    readonly claimViews: readonly ClaimView[];
    readonly records: readonly StepDecisionRecord[];
};

/** The methods of a step, and the full list of its sources: the methods clamp the list for display, and the citation evidence must not. */
function assembleStepMethods(args: StepMethodsInput): { readonly methods: StepMethods; readonly sources: StepMethodsSource[] } | undefined {
    const { grounding, claimViews, records } = args;
    const viewById = new Map(claimViews.map((view) => [view.id, view]));

    const claims = new Map<string, StepMethodsClaim>();
    const addClaim = (id: string, recordTitle?: string): void => {
        const known = claims.get(id);
        // A claim of the grounding with no title in its view takes the title of the first record that names it.
        if (known) {
            if (known.title === undefined && recordTitle !== undefined) claims.set(id, { ...known, title: recordTitle });
            return;
        }
        const view = viewById.get(id);
        claims.set(id, { id, title: view?.title ?? recordTitle, strength: view?.strength });
    };
    for (const id of grounding?.claims ?? []) addClaim(id);
    for (const record of records) for (const claim of record.claims ?? []) addClaim(claim.claim, claim.title);

    const sources = new Map<string, StepMethodsSource>();
    const addSource = (source: StepMethodsSource): void => {
        const key = sourceKey(source);
        if (!sources.has(key)) sources.set(key, source);
    };
    for (const record of records) {
        for (const citation of record.citations ?? []) {
            addSource({ doi: citation.doi, pmid: citation.pmid, url: citation.url, title: citation.title, year: citation.year });
        }
    }
    for (const id of claims.keys()) {
        for (const evidence of viewById.get(id)?.evidence ?? []) {
            if (!evidence.doi && !evidence.pmid && !evidence.url) continue;
            addSource({ doi: evidence.doi, pmid: evidence.pmid, url: evidence.url, title: evidence.title, year: evidence.year });
        }
    }

    const templates: StepMethodsTemplate[] = records.map((record) => ({
        id: record.template.id,
        version: record.template.version,
        label: record.template.label,
        method: { id: record.template.method.id, label: record.template.method.label },
        environmentMatch: record.environment?.match,
        script: stepScriptPath(record.script_path),
    }));

    if (!grounding && claims.size === 0 && templates.length === 0) return undefined;

    const departures: PlanStepDeparture[] = (grounding?.departures ?? []).map((departure) => ({
        rule: departure.rule,
        setting: departure.setting,
        value: departure.value,
        reason: departure.reason,
    }));
    const allClaims = [...claims.values()];
    const allSources = [...sources.values()];
    const licenses = new Set(claimViews.filter((view) => claims.has(view.id)).flatMap((view) => (view.license ? [view.license] : [])));
    const snapshot = grounding && grounding.snapshot !== "none" ? grounding.snapshot : records.find((record) => record.snapshot)?.snapshot?.digest;
    const methods: StepMethods = {
        grounding: grounding?.status,
        snapshot,
        templates,
        claims: allClaims.slice(0, MAX_METHODS_CLAIMS),
        claimsOmitted: allClaims.length > MAX_METHODS_CLAIMS ? allClaims.length - MAX_METHODS_CLAIMS : undefined,
        sources: allSources.slice(0, MAX_METHODS_SOURCES),
        sourcesOmitted: allSources.length > MAX_METHODS_SOURCES ? allSources.length - MAX_METHODS_SOURCES : undefined,
        departures: departures.length > 0 ? departures.slice(0, MAX_METHODS_DEPARTURES) : undefined,
        departuresOmitted: departures.length > MAX_METHODS_DEPARTURES ? departures.length - MAX_METHODS_DEPARTURES : undefined,
        license: licenses.size > 0 ? [...licenses].sort().join(", ") : undefined,
    };
    return { methods, sources: allSources };
}

/** The methods of one step, the full list of its sources, and the record files that they read. */
export type StepMethodsRead = {
    readonly methods?: StepMethods;
    /** Each source of the step. `methods.sources` stops at {@link MAX_METHODS_SOURCES}, and this list does not. */
    readonly sources: readonly StepMethodsSource[];
    readonly recordFiles: readonly string[];
};

/**
 * Read the decision records of one step and build its methods. `claimViews` can hold the views of the
 * whole plan, because the claims of the grounding select them.
 */
export async function readStepMethods(args: {
    readonly grounding?: Grounding;
    readonly claimViews: readonly ClaimView[];
    /** The host directory of the records of the step (`stepDecisionRecordDir`). */
    readonly recordDir: string;
    readonly logger: Logger;
}): Promise<StepMethodsRead> {
    const read = await readStepDecisionRecords(args.recordDir, args.logger);
    const assembled = assembleStepMethods({
        grounding: args.grounding,
        claimViews: claimViewsOfGrounding(args.grounding, args.claimViews),
        records: read.map((entry) => entry.record),
    });
    return { methods: assembled?.methods, sources: assembled?.sources ?? [], recordFiles: read.map((entry) => entry.file) };
}

/** The heading of the block that the host appends to the summary of a step. */
export const METHODS_HEADING = "## Methods and sources";

/** The text of a source: the title, the year, and the identifier. */
function renderSource(source: StepMethodsSource): string {
    const id = source.doi ? `doi:${source.doi}` : source.pmid ? `PMID:${source.pmid}` : source.url;
    return `${source.title}${source.year === undefined ? "" : ` (${source.year})`}${id ? `. ${id}` : ""}`;
}

/**
 * The text of a departure: the rule, then the setting with the value of the plan, or the setting that
 * the plan does not apply, then the reason.
 */
export function renderDeparture(departure: PlanStepDeparture): string {
    if (departure.setting === undefined) return `${departure.rule}: ${departure.reason}`;
    const change = departure.value === undefined ? "not applied" : `= ${JSON.stringify(departure.value)}`;
    return `${departure.rule}: \`${departure.setting}\` ${change}. ${departure.reason}`;
}

/** The markdown block of the methods. The host appends it to the summary, after a horizontal rule. */
export function renderMethodsBlock(methods: StepMethods): string {
    const lines: string[] = [METHODS_HEADING, "", "The host wrote this section from the plan grounding and the decision records of the step.", ""];

    if (methods.grounding) lines.push(`- Grounding: ${methods.grounding}`);
    if (methods.snapshot) lines.push(`- Knowledge release: \`${methods.snapshot}\``);
    for (const template of methods.templates) {
        const facts = [`method ${template.method.id}, ${template.method.label}`];
        if (template.environmentMatch) facts.push(`environment ${template.environmentMatch}`);
        if (template.script) facts.push(`script \`${template.script}\``);
        lines.push(`- Template \`${template.id}@${template.version}\`: ${template.label} (${facts.join("; ")})`);
    }
    // An empty list shows only that no valid record was read: the agent can have deleted a record, or a record can have failed the read.
    if (methods.templates.length === 0) lines.push("- Template: the step kept no valid decision record.");

    if (methods.claims.length > 0) {
        lines.push("", "Rules:", "");
        for (const claim of methods.claims) {
            const strength = claim.strength ? ` (${claim.strength})` : "";
            lines.push(`- ${claim.id}${strength}${claim.title ? `: ${claim.title}` : ""}`);
        }
        if (methods.claimsOmitted) lines.push(`- (+${methods.claimsOmitted} more)`);
    }

    if (methods.departures && methods.departures.length > 0) {
        lines.push("", "Departures from the rules:", "");
        for (const departure of methods.departures) lines.push(`- ${renderDeparture(departure)}`);
        if (methods.departuresOmitted) lines.push(`- (+${methods.departuresOmitted} more)`);
    }

    if (methods.sources.length > 0) {
        lines.push("", "Sources:", "");
        for (const source of methods.sources) lines.push(`- ${renderSource(source)}`);
        if (methods.sourcesOmitted) lines.push(`- (+${methods.sourcesOmitted} more)`);
    }

    if (methods.license) lines.push("", `The rule text is from the knowledge service, under ${methods.license}.`);
    return lines.join("\n");
}

/** The summary markdown with the methods block after it. The block stands alone when the summary is empty. */
export function withMethodsBlock(markdown: string | undefined, methods: StepMethods): string {
    const block = renderMethodsBlock(methods);
    const body = markdown?.trimEnd() ?? "";
    return body.length > 0 ? `${body}\n\n---\n\n${block}\n` : `${block}\n`;
}
