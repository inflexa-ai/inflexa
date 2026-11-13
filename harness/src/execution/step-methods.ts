/**
 * The methods and the sources of one step, as the host builds them after the agent loop. The input is
 * the grounding of the plan step, the claim views that the plan kept, and the decision records that
 * `knowledge_template` wrote into `output/`. The agent does not write the block: the host holds these
 * facts as data, and a summary in prose can drop them.
 *
 * The record files sit in the writable tree of the agent. Thus each read is confined against a planted
 * symlink, bounded in size and in count, and parsed as untrusted data. A record that does not parse is
 * left out, and the grounding still gives the claims and their evidence.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix as posixPath } from "node:path";
import { z } from "zod";

import type { StepMethods, StepMethodsClaim, StepMethodsSource, StepMethodsTemplate } from "../contracts/chat-parts.js";
import { classifyWithinRoot } from "../lib/fs-helpers.js";
import type { Logger } from "../lib/logger.js";
import { safeParseJsonAs } from "../lib/parse-json.js";
import type { ClaimView, Grounding } from "../schemas/workflow-state.js";

/** Claims carried in the methods of one step. The tail is counted. */
export const MAX_METHODS_CLAIMS = 60;

/** Sources carried in the methods of one step. The tail is counted. */
export const MAX_METHODS_SOURCES = 60;

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
});
export type StepDecisionRecord = z.infer<typeof DecisionRecordSchema>;

/**
 * Read the decision records of a step from `output/decision_record_*.json`, in the order of the file
 * names. A file that escapes the step directory, that is too large, or that does not parse is left out
 * with a warning. An absent `output/` directory gives no record.
 */
export async function readStepDecisionRecords(writePrefix: string, logger: Logger): Promise<StepDecisionRecord[]> {
    const outputDir = join(writePrefix, "output");
    let names: string[];
    try {
        names = await readdir(outputDir);
    } catch {
        return [];
    }
    const recordNames = names
        .filter((name) => name.startsWith(RECORD_PREFIX) && name.endsWith(RECORD_SUFFIX))
        .sort()
        .slice(0, MAX_RECORD_FILES);

    const records: StepDecisionRecord[] = [];
    for (const name of recordNames) {
        const path = join(outputDir, name);
        try {
            if ((await classifyWithinRoot(writePrefix, path)) !== "in") {
                logger.warn("a decision record is not inside the step directory, thus the methods leave it out", { file: name });
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
            records.push(parsed.data);
        } catch (err) {
            logger.warn("a decision record read failed, thus the methods leave it out", { file: name, ...logger.errorFields(err) });
        }
    }
    return records;
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
 * one entry for each DOI, PubMed id, or URL. Gives `undefined` when the step has no grounding, no claim,
 * and no record.
 */
export function buildStepMethods(args: {
    readonly grounding?: Grounding;
    readonly claimViews: readonly ClaimView[];
    readonly records: readonly StepDecisionRecord[];
}): StepMethods | undefined {
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

    const allClaims = [...claims.values()];
    const allSources = [...sources.values()];
    const licenses = new Set(claimViews.filter((view) => claims.has(view.id)).flatMap((view) => (view.license ? [view.license] : [])));
    const snapshot = grounding && grounding.snapshot !== "none" ? grounding.snapshot : records.find((record) => record.snapshot)?.snapshot?.digest;
    return {
        grounding: grounding?.status,
        snapshot,
        templates,
        claims: allClaims.slice(0, MAX_METHODS_CLAIMS),
        claimsOmitted: allClaims.length > MAX_METHODS_CLAIMS ? allClaims.length - MAX_METHODS_CLAIMS : undefined,
        sources: allSources.slice(0, MAX_METHODS_SOURCES),
        sourcesOmitted: allSources.length > MAX_METHODS_SOURCES ? allSources.length - MAX_METHODS_SOURCES : undefined,
        license: licenses.size > 0 ? [...licenses].sort().join(", ") : undefined,
    };
}

/** The heading of the block that the host appends to the summary of a step. */
export const METHODS_HEADING = "## Methods and sources";

/** The text of a source: the title, the year, and the identifier. */
function renderSource(source: StepMethodsSource): string {
    const id = source.doi ? `doi:${source.doi}` : source.pmid ? `PMID:${source.pmid}` : source.url;
    return `${source.title}${source.year === undefined ? "" : ` (${source.year})`}${id ? `. ${id}` : ""}`;
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
