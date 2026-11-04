import { createRoot } from "solid-js";

/**
 * Runs `body` inside a Solid reactive root and disposes it afterward — even if `body` throws — so a
 * test's signals, effects, and stores don't leak into the next test. Synchronous: our store/reducer
 * tests read values immediately with no cross-tick tracking, so the root is torn down as soon as the
 * body returns.
 */
export function withRoot<T>(body: () => T): T {
    return createRoot((dispose) => {
        try {
            return body();
        } finally {
            dispose();
        }
    });
}

/**
 * The async twin of `withRoot`: runs `body` inside a Solid reactive root and disposes it when the body
 * settles — also when it rejects, as a failed assertion does — so a watcher that the body started cannot
 * outlive its test and take the state of the next one. Reactive work that the body starts before its
 * first `await` is owned by the root, as with `createRoot`.
 */
export async function withRootAsync<T>(body: () => Promise<T>): Promise<T> {
    return createRoot(async (dispose) => {
        try {
            return await body();
        } finally {
            dispose();
        }
    });
}
