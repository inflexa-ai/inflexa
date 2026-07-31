import { createAnalysisPurge, createDbosWorkflowPurger } from "@inflexa-ai/harness";
import type { AnalysisPurge, Pool } from "@inflexa-ai/harness";

/**
 * One purge adapter per pool, for the lifetime of that pool.
 *
 * The adapter is cheap to build but not free to abandon: constructing the durability-engine client
 * beneath it registers `error` and `connect` handlers on the pool it is handed, and that client
 * cannot be released without ending the pool — so a client built per purge leaves its handler pair
 * behind on a pool that outlives every one of them. Past Node's default max-listener count the
 * accumulation prints a warning to stderr, which in the TUI is the surface the chat is drawn on.
 *
 * Keyed weakly so an adapter dies with the pool it wraps: the TUI holds one pool for the whole
 * session, while a maintenance command opens one for a single run and drains it at the end, and
 * neither should have to remember to unregister anything.
 */
const purgesByPool = new WeakMap<Pool, AnalysisPurge>();

/** The analysis purge over `pool`, built once and reused for every later purge on the same pool. */
export function analysisPurgeFor(pool: Pool): AnalysisPurge {
    const existing = purgesByPool.get(pool);
    if (existing) return existing;
    const purge = createAnalysisPurge({ pool, workflows: createDbosWorkflowPurger({ pool }) });
    purgesByPool.set(pool, purge);
    return purge;
}
