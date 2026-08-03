import { z } from "zod";

export interface SourceHttpOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
    readonly maxRetries?: number;
    readonly retryDelayMs?: number;
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

async function request(url: string, options: SourceHttpOptions, signal: AbortSignal | undefined, init: RequestInit): Promise<SourceHttpResult<Response>> {
    if (signal?.aborted) throw cancellationReason(signal);
    const timeoutMs = options.timeoutMs ?? 15_000;
    const maxRetries = options.maxRetries ?? 0;
    const retryDelayMs = options.retryDelayMs ?? 1_000;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
        try {
            const response = await (options.fetch ?? globalThis.fetch)(url, { ...init, signal: combined });
            if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
                await delay(retryDelayMs * 2 ** attempt, signal);
                continue;
            }
            if (response.status === 404 || response.status === 400 || response.status === 406) {
                return { status: "no_data", detail: `HTTP ${response.status}` };
            }
            if (!response.ok) return { status: "unavailable", detail: `HTTP ${response.status}` };
            return { status: "ok", value: response };
        } catch (error) {
            if (signal?.aborted) throw cancellationReason(signal);
            if (timeout.aborted) return { status: "unavailable", detail: `request timed out after ${timeoutMs}ms` };
            if (attempt < maxRetries) {
                await delay(retryDelayMs * 2 ** attempt, signal);
                continue;
            }
            return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
        }
    }

    return { status: "unavailable", detail: `request failed after ${maxRetries + 1} attempts` };
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
