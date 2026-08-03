import { aggregateCitationResolution } from "./aggregate.js";
import { BoundedTtlCache } from "./cache.js";
import { createArxivCitationClient } from "./clients/arxiv.js";
import { notApplicableOutcome, sourceOutcome } from "./clients/common.js";
import { createCrossrefClient } from "./clients/crossref.js";
import { createDoiRegistryClient } from "./clients/doi-registry.js";
import { createPubmedCitationClient } from "./clients/pubmed.js";
import { createSemanticScholarCitationClient } from "./clients/semantic-scholar.js";
import { DEFAULT_MATCH_CONFIG, type CitationMatchConfig } from "./match.js";
import { citationLookupKey, normalizeCitation } from "./normalize.js";
import { planCitationSources } from "./plan.js";
import { createRateLimitSchedule, type RateLimitConfig, type RateLimitRuntime } from "./rate-limit.js";
import type { SourceHttpOptions } from "../literature/sources/http.js";
import {
    CitationInputSchema,
    type CitationInput,
    type CitationResolutionResult,
    type CitationResolveOptions,
    type CitationResolver,
    type CitationSource,
    type CitationSourceClient,
    type CitationSourceOutcome,
    type CitationSourceRequest,
    type RegistrationAgencyEvidence,
} from "./types.js";

const SOURCE_PLAN_VERSION = "citation-plan-v1";
const SOURCE_ORDER: readonly CitationSource[] = ["doi_registry", "crossref", "pubmed", "arxiv", "semantic_scholar"];

const DEFAULT_RATE_LIMITS: Record<CitationSource, RateLimitConfig> = {
    doi_registry: { maxConcurrency: 2, requestsPerSecond: 5, maxRetries: 2, maxRetryDelayMs: 5_000 },
    crossref: { maxConcurrency: 2, requestsPerSecond: 5, maxRetries: 2, maxRetryDelayMs: 5_000 },
    pubmed: { maxConcurrency: 3, requestsPerSecond: 3, maxRetries: 2, maxRetryDelayMs: 5_000 },
    arxiv: { maxConcurrency: 1, requestsPerSecond: 1, maxRetries: 2, maxRetryDelayMs: 10_000 },
    semantic_scholar: { maxConcurrency: 1, requestsPerSecond: 1, maxRetries: 2, maxRetryDelayMs: 10_000 },
};

export interface CitationResolverSourceConfig extends Partial<RateLimitConfig> {
    readonly enabled?: boolean;
}

export interface CitationResolverConfig {
    readonly maxBatchSize?: number;
    readonly timeoutMs?: number;
    readonly cache?: {
        readonly maximum?: number;
        readonly positiveTtlMs?: number;
        readonly negativeTtlMs?: number;
    };
    readonly match?: Partial<CitationMatchConfig>;
    readonly sources?: Partial<Record<CitationSource, CitationResolverSourceConfig>>;
    readonly crossref?: {
        readonly mailto?: string;
        readonly userAgent?: string;
    };
    readonly ncbiApiKey?: string;
    readonly semanticScholarApiKey?: string;
}

export interface CitationResolverDependencies extends RateLimitRuntime {
    readonly fetch?: typeof globalThis.fetch;
    readonly clients?: readonly CitationSourceClient[];
}

interface PendingCitation {
    readonly input: CitationInput;
    readonly normalized: ReturnType<typeof normalizeCitation>;
    readonly plans: ReturnType<typeof planCitationSources>;
}

function mergedRateLimit(source: CitationSource, config: CitationResolverConfig): RateLimitConfig {
    return { ...DEFAULT_RATE_LIMITS[source], ...(config.sources?.[source] ?? {}) };
}

function createDefaultClients(config: CitationResolverConfig, deps: CitationResolverDependencies): CitationSourceClient[] {
    const runtime: RateLimitRuntime = { ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
    const http = (source: CitationSource): SourceHttpOptions => {
        const limits = mergedRateLimit(source, config);
        return {
            ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
            ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
            schedule: createRateLimitSchedule(limits, runtime),
            maxRetries: limits.maxRetries,
            maxRetryDelayMs: limits.maxRetryDelayMs,
        };
    };
    return [
        createDoiRegistryClient(http("doi_registry")),
        createCrossrefClient({
            ...http("crossref"),
            ...(config.crossref?.mailto === undefined ? {} : { mailto: config.crossref.mailto }),
            ...(config.crossref?.userAgent === undefined ? {} : { userAgent: config.crossref.userAgent }),
        }),
        createPubmedCitationClient({
            ...http("pubmed"),
            ...(config.ncbiApiKey === undefined ? {} : { apiKey: config.ncbiApiKey }),
        }),
        createArxivCitationClient(http("arxiv")),
        createSemanticScholarCitationClient({
            ...http("semantic_scholar"),
            ...(config.semanticScholarApiKey === undefined ? {} : { apiKey: config.semanticScholarApiKey }),
        }),
    ];
}

function cacheable(outcomes: readonly CitationSourceOutcome[]): "positive" | "negative" | undefined {
    if (outcomes.some((outcome) => outcome.status === "unavailable")) return undefined;
    return outcomes.some((outcome) => outcome.records.length > 0) ? "positive" : "negative";
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function withCallerSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return promise;
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

/**
 * Read the DOI registry's outcome as evidence about the registration agency.
 *
 * The registry runs first in `SOURCE_ORDER`, so every later source sees its
 * result. Only a named agency is a finding; every other shape — the registry
 * disabled, unreachable, or silent on the agency — leaves ownership unknown.
 */
function registrationAgencyEvidence(outcome: CitationSourceOutcome | undefined): RegistrationAgencyEvidence {
    if (outcome === undefined) return { status: "undetermined", detail: "the DOI registry was not consulted" };
    const evidence = outcome.identifierEvidence;
    if (evidence?.registrationAgency !== undefined) return { status: "determined", agency: evidence.registrationAgency };
    if (evidence?.exists === false) return { status: "absent" };
    return { status: "undetermined", detail: outcome.detail ?? `the DOI registry returned ${outcome.status}` };
}

/**
 * Run one source over the requests routed to it, keeping its failures its own.
 *
 * A source that throws, or that answers a batch with the wrong number of
 * outcomes, is an unavailable source — the same operational state as an HTTP
 * failure — not a failed batch. Caller cancellation still propagates.
 */
async function runSource(client: CitationSourceClient, requests: readonly CitationSourceRequest[], signal?: AbortSignal): Promise<CitationSourceOutcome[]> {
    const unavailable = (request: CitationSourceRequest, detail: string): CitationSourceOutcome =>
        sourceOutcome(client.source, request.plan.operation, "unavailable", 0, [], detail);
    const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

    if (client.resolveMany === undefined) {
        const settled = await Promise.allSettled(requests.map((request) => client.resolve(request, signal)));
        if (signal?.aborted) throw abortReason(signal);
        return settled.map((outcome, index) => (outcome.status === "fulfilled" ? outcome.value : unavailable(requests[index]!, describe(outcome.reason))));
    }

    try {
        const resolved = await client.resolveMany(requests, signal);
        if (resolved.length === requests.length) return [...resolved];
        return requests.map((request) => unavailable(request, `${client.source} returned ${resolved.length} outcomes for ${requests.length} requests`));
    } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
        return requests.map((request) => unavailable(request, describe(error)));
    }
}

export function createCitationResolver(config: CitationResolverConfig = {}, deps: CitationResolverDependencies = {}): CitationResolver {
    const clients = new Map((deps.clients ?? createDefaultClients(config, deps)).map((client) => [client.source, client]));
    const now = deps.now ?? Date.now;
    const cacheConfig = {
        maximum: config.cache?.maximum ?? 500,
        positiveTtlMs: config.cache?.positiveTtlMs ?? 15 * 60_000,
        negativeTtlMs: config.cache?.negativeTtlMs ?? 2 * 60_000,
    };
    const cache = new BoundedTtlCache<readonly CitationSourceOutcome[]>(cacheConfig.maximum, now);
    const inFlight = new Map<string, Promise<readonly CitationSourceOutcome[]>>();
    const matchConfig: CitationMatchConfig = { ...DEFAULT_MATCH_CONFIG, ...(config.match ?? {}) };
    const maxBatchSize = config.maxBatchSize ?? 200;

    const keyFor = (input: CitationInput): string => `${SOURCE_PLAN_VERSION}:${citationLookupKey(input)}`;

    async function resolveUncachedBatch(entries: readonly PendingCitation[], signal?: AbortSignal): Promise<CitationSourceOutcome[][]> {
        const outcomes = entries.map(() => new Map<CitationSource, CitationSourceOutcome>());
        for (const source of SOURCE_ORDER) {
            const sourceConfig = config.sources?.[source];
            const client = clients.get(source);
            const requests: CitationSourceRequest[] = [];
            const requestIndices: number[] = [];
            for (let index = 0; index < entries.length; index += 1) {
                const entry = entries[index]!;
                const plan = entry.plans.find((candidate) => candidate.source === source)!;
                if (!plan.applicable || sourceConfig?.enabled === false || client === undefined) {
                    outcomes[index]!.set(
                        source,
                        sourceConfig?.enabled === false
                            ? notApplicableOutcome({ ...plan, applicable: false, operation: "none", reason: "source disabled by resolver configuration" })
                            : client === undefined
                              ? notApplicableOutcome({ ...plan, applicable: false, operation: "none", reason: "source client unavailable" })
                              : notApplicableOutcome(plan),
                    );
                    continue;
                }
                requests.push({
                    input: entry.input,
                    normalized: entry.normalized,
                    plan,
                    registrationAgency: registrationAgencyEvidence(outcomes[index]!.get("doi_registry")),
                });
                requestIndices.push(index);
            }
            if (requests.length === 0 || client === undefined) continue;
            const resolved = await runSource(client, requests, signal);
            for (let requestIndex = 0; requestIndex < resolved.length; requestIndex += 1) {
                outcomes[requestIndices[requestIndex]!]!.set(source, resolved[requestIndex]!);
            }
        }
        return entries.map((entry, index) =>
            SOURCE_ORDER.map((source) => outcomes[index]!.get(source) ?? notApplicableOutcome(entry.plans.find((plan) => plan.source === source)!)),
        );
    }

    async function resolveMany(inputs: readonly CitationInput[], options: CitationResolveOptions = {}): Promise<CitationResolutionResult[]> {
        if (inputs.length > maxBatchSize) throw new Error(`citation batch size ${inputs.length} exceeds configured maximum ${maxBatchSize}`);
        if (inputs.length === 0) return [];
        const parsed = inputs.map((input) => CitationInputSchema.parse(input));
        const uniqueOrder: string[] = [];
        const firstByKey = new Map<string, CitationInput>();
        for (const input of parsed) {
            const key = keyFor(input);
            if (!firstByKey.has(key)) {
                uniqueOrder.push(key);
                firstByKey.set(key, input);
            }
        }

        const pending = new Map<string, Promise<readonly CitationSourceOutcome[]>>();
        const uncached: Array<{ readonly key: string; readonly entry: PendingCitation }> = [];
        for (const key of uniqueOrder) {
            const cached = cache.get(key);
            if (cached !== undefined) {
                pending.set(key, Promise.resolve(cached));
                continue;
            }
            const running = inFlight.get(key);
            if (running !== undefined) {
                pending.set(key, running);
                continue;
            }
            const input = firstByKey.get(key)!;
            const normalized = normalizeCitation(input);
            uncached.push({ key, entry: { input, normalized, plans: planCitationSources(input, normalized) } });
        }

        if (uncached.length > 0) {
            const batch = resolveUncachedBatch(
                uncached.map(({ entry }) => entry),
                options.signal,
            );
            for (let index = 0; index < uncached.length; index += 1) {
                const { key } = uncached[index]!;
                const one = batch.then((results) => results[index]!);
                const tracked = one.then(
                    (outcomes) => {
                        const kind = cacheable(outcomes);
                        if (kind !== undefined) cache.set(key, outcomes, kind === "positive" ? cacheConfig.positiveTtlMs : cacheConfig.negativeTtlMs);
                        inFlight.delete(key);
                        return outcomes;
                    },
                    (error: unknown) => {
                        inFlight.delete(key);
                        throw error;
                    },
                );
                inFlight.set(key, tracked);
                pending.set(key, tracked);
            }
        }

        const outcomesByKey = new Map<string, readonly CitationSourceOutcome[]>();
        await Promise.all(
            uniqueOrder.map(async (key) => {
                outcomesByKey.set(key, await withCallerSignal(pending.get(key)!, options.signal));
            }),
        );
        // Aggregated per input, never per shared lookup: comparisons and the
        // verdict they drive belong to the caller's own supplied metadata.
        return parsed.map((input) => aggregateCitationResolution(input, normalizeCitation(input), outcomesByKey.get(keyFor(input))!, matchConfig));
    }

    return {
        resolveOne: async (input, options = {}) => (await resolveMany([input], options))[0]!,
        resolveMany,
    };
}
