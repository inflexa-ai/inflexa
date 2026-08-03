import { aggregateCitationResolution } from "./aggregate.js";
import { BoundedTtlCache } from "./cache.js";
import { createArxivCitationClient } from "./clients/arxiv.js";
import { notApplicableOutcome } from "./clients/common.js";
import { createCrossrefClient } from "./clients/crossref.js";
import { createDoiRegistryClient } from "./clients/doi-registry.js";
import { createPubmedCitationClient } from "./clients/pubmed.js";
import { createSemanticScholarCitationClient } from "./clients/semantic-scholar.js";
import { CITATION_COMPARISON_RULE_VERSION } from "./compare.js";
import { DEFAULT_MATCH_CONFIG, type CitationMatchConfig } from "./match.js";
import { citationCacheKey, normalizeCitation } from "./normalize.js";
import { planCitationSources } from "./plan.js";
import { createRateLimitedFetch, type RateLimitConfig, type RateLimitRuntime } from "./rate-limit.js";
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
    const fetcher = deps.fetch ?? globalThis.fetch;
    const scheduled = (source: CitationSource): typeof globalThis.fetch =>
        createRateLimitedFetch(fetcher, mergedRateLimit(source, config), {
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
        });
    const common = { ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) };
    return [
        createDoiRegistryClient({ ...common, fetch: scheduled("doi_registry") }),
        createCrossrefClient({
            ...common,
            fetch: scheduled("crossref"),
            ...(config.crossref?.mailto === undefined ? {} : { mailto: config.crossref.mailto }),
            ...(config.crossref?.userAgent === undefined ? {} : { userAgent: config.crossref.userAgent }),
        }),
        createPubmedCitationClient({
            ...common,
            fetch: scheduled("pubmed"),
            ...(config.ncbiApiKey === undefined ? {} : { apiKey: config.ncbiApiKey }),
        }),
        createArxivCitationClient({ ...common, fetch: scheduled("arxiv") }),
        createSemanticScholarCitationClient({
            ...common,
            fetch: scheduled("semantic_scholar"),
            ...(config.semanticScholarApiKey === undefined ? {} : { apiKey: config.semanticScholarApiKey }),
        }),
    ];
}

function cacheable(result: CitationResolutionResult): "positive" | "negative" | undefined {
    if (result.sourceOutcomes.some((outcome) => outcome.status === "unavailable")) return undefined;
    if (result.verdict === "verified" || result.verdict === "metadata_mismatch") return "positive";
    if (result.verdict === "not_found" || result.verdict === "unverifiable") return "negative";
    return undefined;
}

function withCallerSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return promise;
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
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

export function createCitationResolver(config: CitationResolverConfig = {}, deps: CitationResolverDependencies = {}): CitationResolver {
    const clients = new Map((deps.clients ?? createDefaultClients(config, deps)).map((client) => [client.source, client]));
    const now = deps.now ?? Date.now;
    const cacheConfig = {
        maximum: config.cache?.maximum ?? 500,
        positiveTtlMs: config.cache?.positiveTtlMs ?? 15 * 60_000,
        negativeTtlMs: config.cache?.negativeTtlMs ?? 2 * 60_000,
    };
    const cache = new BoundedTtlCache<CitationResolutionResult>(cacheConfig.maximum, now);
    const inFlight = new Map<string, Promise<CitationResolutionResult>>();
    const matchConfig: CitationMatchConfig = { ...DEFAULT_MATCH_CONFIG, ...(config.match ?? {}) };
    const maxBatchSize = config.maxBatchSize ?? 200;

    const keyFor = (input: CitationInput): string => `${SOURCE_PLAN_VERSION}:${CITATION_COMPARISON_RULE_VERSION}:${citationCacheKey(input)}`;

    async function resolveUncachedBatch(entries: readonly PendingCitation[], signal?: AbortSignal): Promise<CitationResolutionResult[]> {
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
                const doiOutcome = outcomes[index]!.get("doi_registry");
                requests.push({
                    input: entry.input,
                    normalized: entry.normalized,
                    plan,
                    ...(doiOutcome?.identifierEvidence?.registrationAgency === undefined
                        ? {}
                        : { registrationAgency: doiOutcome.identifierEvidence.registrationAgency }),
                });
                requestIndices.push(index);
            }
            if (requests.length === 0 || client === undefined) continue;
            const resolved =
                client.resolveMany === undefined
                    ? await Promise.all(requests.map((request) => client.resolve(request, signal)))
                    : await client.resolveMany(requests, signal);
            if (resolved.length !== requests.length)
                throw new Error(`${source} resolveMany returned ${resolved.length} outcomes for ${requests.length} requests`);
            for (let requestIndex = 0; requestIndex < resolved.length; requestIndex += 1) {
                outcomes[requestIndices[requestIndex]!]!.set(source, resolved[requestIndex]!);
            }
        }
        return entries.map((entry, index) =>
            aggregateCitationResolution(
                entry.input,
                entry.normalized,
                SOURCE_ORDER.map((source) => outcomes[index]!.get(source) ?? notApplicableOutcome(entry.plans.find((plan) => plan.source === source)!)),
                matchConfig,
            ),
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

        const pending = new Map<string, Promise<CitationResolutionResult>>();
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
                    (result) => {
                        const kind = cacheable(result);
                        if (kind !== undefined) cache.set(key, result, kind === "positive" ? cacheConfig.positiveTtlMs : cacheConfig.negativeTtlMs);
                        inFlight.delete(key);
                        return result;
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

        const uniqueResults = new Map<string, CitationResolutionResult>();
        await Promise.all(
            uniqueOrder.map(async (key) => {
                uniqueResults.set(key, await withCallerSignal(pending.get(key)!, options.signal));
            }),
        );
        return parsed.map((input) => ({
            ...uniqueResults.get(keyFor(input))!,
            input,
            normalized: normalizeCitation(input),
        }));
    }

    return {
        resolveOne: async (input, options = {}) => (await resolveMany([input], options))[0]!,
        resolveMany,
    };
}
