import { z } from "zod";

export interface SourceHttpOptions {
    readonly fetch?: typeof globalThis.fetch;
    /**
     * Admission gate wrapped around each network attempt — a rate limiter, a
     * concurrency semaphore, or both. The request timeout is armed *inside* it,
     * so time an attempt spends queueing is never charged against the timeout.
     */
    readonly schedule?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
    readonly timeoutMs?: number;
    readonly maxRetries?: number;
    readonly retryDelayMs?: number;
    /** Ceiling on any single retry wait, including one a server asks for via `Retry-After`. */
    readonly maxRetryDelayMs?: number;
    readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export type SourceHttpResult<T> =
    | { readonly status: "ok"; readonly value: T }
    | { readonly status: "no_data"; readonly detail: string }
    | { readonly status: "unavailable"; readonly detail: string };

const RETRYABLE_STATUSES = new Set([429, 503]);

function cancellationReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) throw cancellationReason(signal);
    await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
            clearTimeout(timeout);
            reject(cancellationReason(signal!));
        };
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function retryAfterMilliseconds(response: Response): number | undefined {
    const value = response.headers.get("retry-after")?.trim();
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function request(url: string, options: SourceHttpOptions, signal: AbortSignal | undefined, init: RequestInit): Promise<SourceHttpResult<Response>> {
    if (signal?.aborted) throw cancellationReason(signal);
    const timeoutMs = options.timeoutMs ?? 15_000;
    const maxRetries = options.maxRetries ?? 0;
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? Number.POSITIVE_INFINITY;
    const schedule = options.schedule ?? (<T>(operation: () => Promise<T>): Promise<T> => operation());
    const sleep = options.sleep ?? delay;
    const fetcher = options.fetch ?? globalThis.fetch;
    const backoff = (attempt: number): number => Math.min(maxRetryDelayMs, retryDelayMs * 2 ** attempt);

    for (let attempt = 0; ; attempt += 1) {
        let timeout: AbortSignal | undefined;
        try {
            const response = await schedule(async () => {
                timeout = AbortSignal.timeout(timeoutMs);
                const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
                return await fetcher(url, { ...init, signal: combined });
            }, signal);
            if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
                await sleep(Math.min(maxRetryDelayMs, retryAfterMilliseconds(response) ?? backoff(attempt)), signal);
                continue;
            }
            if (response.status === 404 || response.status === 400 || response.status === 406) {
                return { status: "no_data", detail: `HTTP ${response.status}` };
            }
            if (!response.ok) return { status: "unavailable", detail: `HTTP ${response.status}` };
            return { status: "ok", value: response };
        } catch (error) {
            if (signal?.aborted) throw cancellationReason(signal);
            if (timeout?.aborted) return { status: "unavailable", detail: `request timed out after ${timeoutMs}ms` };
            if (attempt < maxRetries) {
                await sleep(backoff(attempt), signal);
                continue;
            }
            return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
        }
    }
}

export async function requestJson<S extends z.ZodType>(
    url: string,
    schema: S,
    options: SourceHttpOptions,
    signal?: AbortSignal,
    init: RequestInit = {},
): Promise<SourceHttpResult<z.infer<S>>> {
    const response = await request(url, options, signal, init);
    if (response.status !== "ok") return response;
    try {
        const parsed = schema.safeParse(await response.value.json());
        if (!parsed.success) return { status: "unavailable", detail: `response schema mismatch: ${parsed.error.issues[0]?.message ?? "unknown"}` };
        return { status: "ok", value: parsed.data };
    } catch (error) {
        return { status: "unavailable", detail: `invalid JSON response: ${error instanceof Error ? error.message : String(error)}` };
    }
}

export async function requestText(url: string, options: SourceHttpOptions, signal?: AbortSignal, init: RequestInit = {}): Promise<SourceHttpResult<string>> {
    const response = await request(url, options, signal, init);
    if (response.status !== "ok") return response;
    try {
        return { status: "ok", value: await response.value.text() };
    } catch (error) {
        return { status: "unavailable", detail: `invalid text response: ${error instanceof Error ? error.message : String(error)}` };
    }
}
