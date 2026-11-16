/**
 * The methods and the sources of one step, as a reader asks for them. The input is the grounding of the plan
 * step, the claim views that the plan kept, and the scripts of the step that `run_template` wrote, as the
 * artifact ledger records them. The agent does not write the methods: the host holds these facts as data, and a
 * summary in prose can drop them.
 */

import { posix as posixPath } from "node:path";

import type { ResultAsync } from "neverthrow";

import type { PlanStepDeparture } from "../contracts/chat-parts.js";
import { citationKey } from "../contracts/report-reference.js";
import type { DbError } from "../lib/db-result.js";
import type { ClaimView, Grounding } from "../schemas/workflow-state.js";
import { queryStepTemplateArtifacts, type StepTemplateArtifact } from "../state/artifacts.js";
import type { Querier } from "../state/db.js";

/** A template that a step rendered, as the artifact ledger names it. */
export type StepMethodsTemplate = {
    id: string;
    version: string;
    label: string;
    /** The catalog method that the script runs. */
    method: { id: string; label: string };
    /** How the installed packages matched the pins of the template (`exact`, `compatible`, and the others). */
    environmentMatch?: string;
    /** The script path inside the step directory, for example `tpl-edger-ql.R`. */
    script?: string;
};

/** A rule of the knowledge service that the step obeys. */
export type StepMethodsClaim = {
    /** The claim id with its release, for example `R-0028@d560`. */
    id: string;
    title?: string;
    strength?: string;
};

/** A published source of a rule or a template. A source carries a DOI, a PubMed id, or a URL. */
export type StepMethodsSource = {
    doi?: string;
    pmid?: string;
    url?: string;
    title: string;
    year?: number;
};

/**
 * The methods and the sources of one step, as the host builds them from the plan grounding and the
 * rendered scripts of the step. The agent of the step does not write them.
 */
export type StepMethods = {
    /** The grounding status of the plan step. Absent when the step has no grounding. */
    grounding?: "grounded" | "ungrounded" | "flagged";
    /** The snapshot digest of the knowledge release. */
    snapshot?: string;
    /** One entry for each rendered script, in the order of the script paths. */
    templates: StepMethodsTemplate[];
    claims: StepMethodsClaim[];
    /** The count of the claims past the bound of the list. */
    claimsOmitted?: number;
    sources: StepMethodsSource[];
    /** The count of the sources past the bound of the list. */
    sourcesOmitted?: number;
    /** The departures of the plan step from its rules. Absent when the step has none. */
    departures?: PlanStepDeparture[];
    /** The count of the departures past the bound of the list. */
    departuresOmitted?: number;
    /** The license of the rule text, for the attribution. */
    license?: string;
};

/** Claims carried in the methods of one step. The tail is counted. */
export const MAX_METHODS_CLAIMS = 60;

/** Sources carried in the methods of one step. The tail is counted. */
export const MAX_METHODS_SOURCES = 60;

/** Departures carried in the methods of one step. The tail is counted. */
export const MAX_METHODS_DEPARTURES = 30;

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

/** The template of a rendered script as the methods name it. `tpl-x@1.0.0` gives the id `tpl-x` and the version `1.0.0`. */
function templateOf(artifact: StepTemplateArtifact, stepDir: string): StepMethodsTemplate {
    const ref = artifact.template.template;
    const at = ref.lastIndexOf("@");
    return {
        id: at < 0 ? ref : ref.slice(0, at),
        version: at < 0 ? "" : ref.slice(at + 1),
        label: artifact.template.label,
        method: artifact.template.method,
        environmentMatch: artifact.template.environmentMatch,
        script: artifact.path.startsWith(`${stepDir}/`) ? artifact.path.slice(stepDir.length + 1) : posixPath.basename(artifact.path),
    };
}

type StepMethodsInput = {
    readonly grounding?: Grounding;
    /** The views of the claims of the grounding, or of the whole plan: the claims of the grounding select them. */
    readonly claimViews: readonly ClaimView[];
    /** The scripts of the step that a template rendered. */
    readonly templates: readonly StepTemplateArtifact[];
    /** The workspace-relative directory of the step, `runs/{runId}/{stepId}`: a script path is named relative to it. */
    readonly stepDir: string;
};

/** The methods of a step, and the full list of its sources: the methods clamp the list for display, and the citation evidence must not. */
export type StepMethodsRead = {
    readonly methods?: StepMethods;
    /** Each source of the step. `methods.sources` stops at {@link MAX_METHODS_SOURCES}, and this list does not. */
    readonly sources: readonly StepMethodsSource[];
};

/**
 * Build the methods of a step. The claims are the claims of the grounding with the title and the strength of
 * their views. The sources are the evidence of the views, one entry for each DOI, PubMed id, or URL. The templates
 * are the scripts that `run_template` wrote. The departures are the departures of the grounding. Gives no methods
 * when the step has no grounding and no rendered script.
 */
export function buildStepMethods(args: StepMethodsInput): StepMethodsRead {
    const { grounding, templates } = args;
    const views = claimViewsOfGrounding(grounding, args.claimViews);
    const viewById = new Map(views.map((view) => [view.id, view]));

    const claims: StepMethodsClaim[] = (grounding?.claims ?? []).map((id) => {
        const view = viewById.get(id);
        return { id, title: view?.title, strength: view?.strength };
    });

    const sources = new Map<string, StepMethodsSource>();
    for (const view of views) {
        for (const evidence of view.evidence) {
            if (!evidence.doi && !evidence.pmid && !evidence.url) continue;
            const source: StepMethodsSource = { doi: evidence.doi, pmid: evidence.pmid, url: evidence.url, title: evidence.title, year: evidence.year };
            const key = sourceKey(source);
            if (!sources.has(key)) sources.set(key, source);
        }
    }

    if (!grounding && templates.length === 0) return { sources: [] };

    const departures: PlanStepDeparture[] = (grounding?.departures ?? []).map((departure) => ({
        rule: departure.rule,
        setting: departure.setting,
        value: departure.value,
        reason: departure.reason,
    }));
    const allSources = [...sources.values()];
    const licenses = new Set(views.flatMap((view) => (view.license ? [view.license] : [])));
    const snapshot = grounding && grounding.snapshot !== "none" ? grounding.snapshot : templates[0]?.template.snapshot;
    const methods: StepMethods = {
        grounding: grounding?.status,
        snapshot,
        templates: templates.map((artifact) => templateOf(artifact, args.stepDir)),
        claims: claims.slice(0, MAX_METHODS_CLAIMS),
        claimsOmitted: claims.length > MAX_METHODS_CLAIMS ? claims.length - MAX_METHODS_CLAIMS : undefined,
        sources: allSources.slice(0, MAX_METHODS_SOURCES),
        sourcesOmitted: allSources.length > MAX_METHODS_SOURCES ? allSources.length - MAX_METHODS_SOURCES : undefined,
        departures: departures.length > 0 ? departures.slice(0, MAX_METHODS_DEPARTURES) : undefined,
        departuresOmitted: departures.length > MAX_METHODS_DEPARTURES ? departures.length - MAX_METHODS_DEPARTURES : undefined,
        license: licenses.size > 0 ? [...licenses].sort().join(", ") : undefined,
    };
    return { methods, sources: allSources };
}

/** Read the rendered scripts of one step from the artifact ledger, and build its methods. */
export function readStepMethods(args: {
    readonly pool: Querier;
    readonly analysisId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly grounding?: Grounding;
    readonly claimViews: readonly ClaimView[];
}): ResultAsync<StepMethodsRead, DbError> {
    return queryStepTemplateArtifacts(args.pool, args.analysisId, args.runId, args.stepId).map((templates) =>
        buildStepMethods({
            grounding: args.grounding,
            claimViews: args.claimViews,
            templates,
            stepDir: `runs/${args.runId}/${args.stepId}`,
        }),
    );
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
