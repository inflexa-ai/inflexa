import type { Pool } from "@inflexa-ai/harness";
import { Hono } from "hono";
import { ResultAsync } from "neverthrow";
import { z } from "zod";

import type { DurableWork, ServerActivity, ShutdownAccepted } from "../../api/server.ts";
import { getLogger } from "../../lib/log.ts";
import type { ServerBoot } from "../boot.ts";
import { readBody, type ServerEnv } from "../http.ts";
import type { ServerLifecycle } from "../lifecycle.ts";
import { profileWorkCount } from "../profile_queue.ts";
import { runningTurnCount } from "../turns.ts";

/** The reads of `GET /api/v1/server/activity`. Tests replace each one, because no cli test reaches Postgres. */
export type ServerRouteOpts = {
    readonly runningTurnCount: () => number;
    readonly profileWorkCount: () => number;
    /** The runs and the data profiles with a live workflow. The error channel means the ledger is unreadable. */
    readonly durableWork: (pool: Pool) => ResultAsync<{ runs: number; profiles: number }, unknown>;
};

/** The production {@link ServerRouteOpts}. */
export const DEFAULT_SERVER_ROUTE_OPTS: ServerRouteOpts = {
    runningTurnCount,
    profileWorkCount,
    durableWork,
};

const shutdownBody = z.object({ mode: z.enum(["now", "drain"]) });

/**
 * The routes under `/api/v1/server`: the boot state, a new boot after a failure, the work that a stop
 * interrupts, and the stop. None needs the runtime.
 */
export function serverRoutes(boot: ServerBoot, lifecycle: ServerLifecycle, opts: ServerRouteOpts = DEFAULT_SERVER_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();
    routes.get("/", (c) => c.json(boot.state()));
    // 202: the boot runs after the response. The client reads `GET /api/v1/server` until the phase settles.
    routes.post("/boot", (c) => {
        void boot.start();
        return c.json(boot.state(), 202);
    });
    routes.get("/activity", async (c) => {
        const runtime = boot.runtime();
        const durable: DurableWork =
            runtime === null
                ? { state: "no_runtime" }
                : (await opts.durableWork(runtime.pool)).match(
                      ({ runs, profiles }): DurableWork => ({ state: "counted", runs, profiles }),
                      (cause): DurableWork => {
                          getLogger("server").warn({ err: cause }, "could not count the durable work");
                          return { state: "unreadable" };
                      },
                  );
        return c.json<ServerActivity>({ stopping: lifecycle.stopping(), turns: opts.runningTurnCount(), profileDrives: opts.profileWorkCount(), durable });
    });
    // 202: the stop runs after the response. The client waits for the exit of the pid in the discovery file.
    routes.post("/shutdown", async (c) => {
        const body = await readBody(c, shutdownBody);
        if (body.isErr()) return body.error;
        return c.json<ShutdownAccepted>(lifecycle.requestShutdown(body.value.mode), 202);
    });
    return routes;
}

/**
 * The runs and the data profiles whose durable workflow is live, over each analysis, in one read. A ledger row
 * counts only while a `PENDING` or `ENQUEUED` workflow stands behind it: a crashed host leaves a `running` row
 * for ever, while its workflow settles terminal. The run status set is the one of `queryActiveRunsByAnalysis`
 * of the harness, and a run counts with its `<runId>-N` children, as in the busy gate. A profile row whose
 * workflow id is not recorded yet does not count: its profile drive counts instead.
 */
function durableWork(pool: Pool): ResultAsync<{ runs: number; profiles: number }, unknown> {
    return ResultAsync.fromPromise(
        pool.query<{ runs: string; profiles: string }>({
            text: `SELECT
                     (SELECT COUNT(*) FROM cortex_runs r
                        WHERE r.status IN ('running', 'suspended_insufficient_funds')
                          AND EXISTS (SELECT 1 FROM dbos.workflow_status ws
                                       WHERE ws.status IN ('PENDING', 'ENQUEUED')
                                         AND (ws.workflow_uuid = r.run_id OR ws.workflow_uuid LIKE r.run_id || '-%'))) AS runs,
                     (SELECT COUNT(*) FROM cortex_analysis_state s
                        WHERE s.data_profile_status = 'running'
                          AND EXISTS (SELECT 1 FROM dbos.workflow_status ws
                                       WHERE ws.status IN ('PENDING', 'ENQUEUED')
                                         AND ws.workflow_uuid = s.data_profile_workflow_id)) AS profiles`,
        }),
        (cause) => cause,
    ).map((result) => ({ runs: Number(result.rows[0]?.runs ?? 0), profiles: Number(result.rows[0]?.profiles ?? 0) }));
}
