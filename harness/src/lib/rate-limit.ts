export interface RateLimitConfig {
    readonly maxConcurrency: number;
    readonly requestsPerSecond: number;
    /**
     * Retry policy for the source's HTTP layer. Retries re-enter the limiter as
     * fresh attempts, so they are paced like any other request; the limiter
     * itself does not read these two fields.
     */
    readonly maxRetries: number;
    readonly maxRetryDelayMs: number;
}

export interface RateLimitRuntime {
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

export function sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        const onAbort = (): void => {
            clearTimeout(timeout);
            reject(abortReason(signal!));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

class Semaphore {
    private active = 0;
    private readonly waiters: Array<{
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
        readonly signal?: AbortSignal;
        readonly onAbort?: () => void;
    }> = [];

    constructor(private readonly maximum: number) {}

    async acquire(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throw abortReason(signal);
        if (this.active < this.maximum) {
            this.active += 1;
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const waiter: {
                resolve: () => void;
                reject: (error: Error) => void;
                signal?: AbortSignal;
                onAbort?: () => void;
            } = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
            if (signal !== undefined) {
                waiter.onAbort = () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                    reject(abortReason(signal));
                };
                signal.addEventListener("abort", waiter.onAbort, { once: true });
            }
            this.waiters.push(waiter);
        });
    }

    release(): void {
        const waiter = this.waiters.shift();
        if (waiter === undefined) {
            this.active -= 1;
            return;
        }
        if (waiter.signal !== undefined && waiter.onAbort !== undefined) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve();
    }
}

export class BoundedRateLimiter {
    private readonly semaphore: Semaphore;
    private readonly now: () => number;
    private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    private reservationTail: Promise<void> = Promise.resolve();
    private nextStartAt = 0;

    constructor(
        private readonly config: RateLimitConfig,
        runtime: RateLimitRuntime = {},
    ) {
        if (!Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1) throw new Error("maxConcurrency must be a positive integer");
        if (!(config.requestsPerSecond > 0)) throw new Error("requestsPerSecond must be positive");
        this.semaphore = new Semaphore(config.maxConcurrency);
        this.now = runtime.now ?? Date.now;
        this.sleep = runtime.sleep ?? sleepWithSignal;
    }

    private async reserveStart(signal?: AbortSignal): Promise<number> {
        let release!: () => void;
        const predecessor = this.reservationTail;
        this.reservationTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        if (signal?.aborted) {
            release();
            throw abortReason(signal);
        }
        await predecessor;
        try {
            if (signal?.aborted) throw abortReason(signal);
            const startAt = Math.max(this.now(), this.nextStartAt);
            this.nextStartAt = startAt + 1000 / this.config.requestsPerSecond;
            return startAt;
        } finally {
            release();
        }
    }

    async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const startAt = await this.reserveStart(signal);
        await this.sleep(Math.max(0, startAt - this.now()), signal);
        await this.semaphore.acquire(signal);
        try {
            return await operation();
        } finally {
            this.semaphore.release();
        }
    }
}

/**
 * Admission gate for a source's HTTP layer (`SourceHttpOptions.schedule`).
 *
 * It gates the network call alone: the caller arms its request timeout inside
 * the admitted operation, so a request held behind pacing or a concurrency
 * ceiling cannot be reported as a timeout before it ever reaches the network.
 */
export function createRateLimitSchedule(
    config: RateLimitConfig,
    runtime: RateLimitRuntime = {},
): <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
    const limiter = new BoundedRateLimiter(config, runtime);
    return (operation, signal) => limiter.run(operation, signal);
}
