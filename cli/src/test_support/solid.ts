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
