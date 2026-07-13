/**
 * `bootHarness` — the harness-owned boot sequence.
 *
 * `assembleCoreRuntime` stays sync and pure (it is the register-before-launch
 * cohort SOT, driven by tests on `passthroughStep`). `bootHarness` wraps it with
 * the ordered, effectful boot steps every host must run in the same order, and
 * returns a `shutdown` handle the embedder wires to its process signals. The
 * ordering is load-bearing and runs cheapest-failure-first:
 *
 *   1. `initTelemetry()` — before any tracer/meter is read. Injected; defaults
 *      to a no-op so a library host never acquires process-wide telemetry (or a
 *      console banner) it did not ask for. An embedder that wants harness OTel
 *      passes `initOtel` / `shutdownOtel` here.
 *   2. `validateAgentSkills(skillsDir, SANDBOX_AGENT_META)` — pure fs stat, zero
 *      external deps. A `meta.skills` typo or a `skillsDir` / image drift dies in
 *      milliseconds, before any Postgres or DBOS cost is paid (agent-skill-assignment).
 *   3. `initCortexState(pool)` — app tables must exist before launch; recovery
 *      queries them on the first step.
 *   4. `assertConnectionBudget(...)` — needs the live pool; gates launch so a
 *      misconfigured pool fails loudly at boot, not under load.
 *   5. `assembleCoreRuntime(core)` — registers the durable-workflow cohort and
 *      builds the conversation agent (register-before-launch invariant).
 *   6. `beforeLaunch()` — embedder hook for host-specific pre-launch work that
 *      must attach before DBOS launch re-emits events (scheduled sweeps, an
 *      ephemeral-workflow reap, an agent-switch install). Runs after registration
 *      so it may close over the registered callables.
 *   7. `launchDbos(...)` — the last registration-dependent step.
 *
 * Boot-step errors PROPAGATE (the embedder's composition root catches them and
 * releases whatever it acquired). Only `shutdown` swallows per-step failures —
 * once shutdown starts, exiting takes precedence (see `runShutdownSequence`).
 */

import type { Pool } from "pg";
import type pino from "pino";

import { SANDBOX_AGENT_META } from "../agents/sandbox/index.js";
import { validateAgentSkills } from "../agents/sandbox/validate-skills.js";
import { initCortexState } from "../state/init.js";
import { assembleCoreRuntime, type CoreRuntime, type CoreRuntimeDeps } from "./assemble.js";
import { assertConnectionBudget, type ConnectionBudgetConfig } from "./connection-budget.js";
import { launchDbos, shutdownDbos, type DbosConfig } from "./dbos.js";
import { markDraining } from "./lifecycle.js";
import { runShutdownSequence } from "./shutdown.js";

const noop = (): void => {};
const noopAsync = (): Promise<void> => Promise.resolve();

export interface BootHarnessDeps {
    /** Everything `assembleCoreRuntime` needs (workflow + conversation deps, resource policy). */
    readonly core: CoreRuntimeDeps;
    /** App `pg.Pool` — used for state init, the connection-budget guard, and closed on shutdown. */
    readonly pool: Pool;
    /** Skills root; validated against the harness-owned agent catalog before launch. */
    readonly skillsDir: string;
    /** DBOS launch config (carries the stable `executorId`). */
    readonly dbos: DbosConfig;
    /** Connection-budget guard config. */
    readonly connectionBudget: ConnectionBudgetConfig;
    readonly logger: pino.Logger;
    /**
     * Host-specific work that must run AFTER workflow registration and BEFORE
     * DBOS launch (scheduled sweeps, ephemeral reap, agent-switch install). The
     * booted runtime is not returned until after launch, so this hook captures
     * whatever it needs from the embedder's own composition root.
     */
    readonly beforeLaunch?: () => void | Promise<void>;
    /** Telemetry init. Default no-op; pass `initOtel` to enable harness OTel. */
    readonly initTelemetry?: () => void;
    /** Shutdown-time telemetry flush. Default no-op; pass `shutdownOtel` to match. */
    readonly shutdownTelemetry?: () => Promise<void>;
    /** HTTP drain at shutdown. Default no-op — a library host owns no server. */
    readonly closeHttpServer?: () => Promise<void>;
    /** Logger flush at shutdown. Default no-op. */
    readonly flushLogger?: () => Promise<void>;
    /** Process exit at shutdown. Default no-op — the embedder owns process lifecycle. */
    readonly exit?: (code: number) => void;
}

export interface BootedHarness {
    readonly runtime: CoreRuntime;
    /** Runs the graceful-shutdown sequence in durability order. Wire to SIGTERM/SIGINT. */
    readonly shutdown: (signal: string) => Promise<void>;
}

export async function bootHarness(deps: BootHarnessDeps): Promise<BootedHarness> {
    const { core, pool, skillsDir, logger } = deps;

    (deps.initTelemetry ?? noop)();

    validateAgentSkills(skillsDir, SANDBOX_AGENT_META);

    await initCortexState(pool);
    await assertConnectionBudget({ pool, logger, config: deps.connectionBudget });

    const runtime = assembleCoreRuntime(core);

    await deps.beforeLaunch?.();

    await launchDbos({ config: deps.dbos, logger });

    logger.info({ executorId: deps.dbos.executorId }, "[boot] harness booted");

    const shutdown = (signal: string): Promise<void> =>
        runShutdownSequence({
            signal,
            logger,
            markDraining,
            closeHttpServer: deps.closeHttpServer ?? noopAsync,
            shutdownDbos: () => shutdownDbos({ logger }),
            closePool: () => pool.end(),
            flushLogger: deps.flushLogger ?? noopAsync,
            shutdownOtel: deps.shutdownTelemetry ?? noopAsync,
            exit: deps.exit ?? noop,
        });

    return { runtime, shutdown };
}
