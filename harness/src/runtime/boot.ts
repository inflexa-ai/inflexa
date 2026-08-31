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
 *   2. `validateAgentSkills(skillsDir, ...)` — pure fs stat, zero external deps.
 *      A `meta.skills` typo or a `skillsDir` / image drift dies in milliseconds,
 *      before any Postgres or DBOS cost is paid (agent-skill-assignment).
 *   3. `initCortexState(pool)` — app tables must exist before launch; recovery
 *      queries them on the first step.
 *   4. `assertConnectionBudget(...)` — needs the live pool; gates launch so a
 *      misconfigured pool fails loudly at boot, not under load.
 *   5. `assembleCoreRuntime(core)` — registers the durable-workflow cohort and
 *      builds the conversation agent (register-before-launch invariant).
 *   6. `beforeLaunch()` — embedder hook for host-specific pre-launch work that
 *      must attach before DBOS launch re-emits events (scheduled sweeps, an
 *      legacy-workflow reap, an agent-switch install). Runs after registration
 *      so it may close over the registered callables.
 *   7. `launchDbos(...)` — the last registration-dependent step.
 *
 * No step reads or rewrites stored conversation display. A boot that validated
 * every `messages` row is what let a single retired part key fail startup for a
 * whole deployment; the read tolerates such a row by itself now
 * (`parseStoredDisplayEnvelope`), which is where a per-row concern belongs.
 *
 * Boot-step errors PROPAGATE (the embedder's composition root catches them and
 * releases whatever it acquired). Only `shutdown` swallows per-step failures —
 * once shutdown starts, exiting takes precedence (see `runShutdownSequence`).
 */

import type { Pool } from "pg";

import type { Logger } from "../lib/logger.js";
import { SANDBOX_AGENT_META } from "../agents/sandbox/index.js";
import { validateAgentSkills } from "../agents/sandbox/validate-skills.js";
import { initCortexState } from "../state/init.js";
import { assembleCoreRuntime, resolveCompositionKnowledge, type CoreRuntime, type CoreRuntimeDeps } from "./assemble.js";
import { assertConnectionBudget, type ConnectionBudgetConfig } from "./connection-budget.js";
import { launchDbos, shutdownDbos, type DbosConfig } from "./dbos.js";
import { markDraining } from "./lifecycle.js";
import { runShutdownSequence } from "./shutdown.js";

const noop = (): void => {};
const noopAsync = (): Promise<void> => Promise.resolve();

/** Every agent whose declared packs must resolve before the first run. */
const SKILL_DECLARING_AGENTS = SANDBOX_AGENT_META;

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
    readonly logger: Logger;
    /**
     * Host-specific work that must run AFTER workflow registration and BEFORE
     * DBOS launch (scheduled sweeps, legacy-row reap, agent-switch install). The
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

    validateAgentSkills(skillsDir, SKILL_DECLARING_AGENTS);

    await initCortexState(pool);
    await assertConnectionBudget({ pool, logger, config: deps.connectionBudget });

    // The knowledge source resolves here because the corpus load reads files
    // and `assembleCoreRuntime` stays sync. An absent source is a normal
    // condition, thus this step never fails the boot.
    const knowledge = await resolveCompositionKnowledge({
        ...(core.knowledge ? { knowledge: core.knowledge } : {}),
        ...(core.knowledgeDir !== undefined ? { knowledgeDir: core.knowledgeDir } : {}),
        ...(core.observeKnowledge ? { observeKnowledge: core.observeKnowledge } : {}),
        logger,
    });

    const runtime = assembleCoreRuntime({ ...core, ...(knowledge ? { knowledge } : {}) });

    await deps.beforeLaunch?.();

    await launchDbos({ config: deps.dbos, logger });

    logger.named("boot").info("harness booted", { executorId: deps.dbos.executorId });

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
