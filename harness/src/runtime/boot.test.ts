import { describe, expect, it } from "bun:test";
import { silentLogger } from "../__tests__/setup/logger.js";
import type { Pool } from "pg";

import { bootHarness, type BootHarnessDeps } from "./boot.js";
import type { CoreRuntimeDeps } from "./assemble.js";
import type { DbosConfig } from "./dbos.js";
import type { ConnectionBudgetConfig } from "./connection-budget.js";

/** A pool that fails loudly if boot reaches state-init / the budget guard. */
function explodingPool(onUse: () => void): Pool {
    const trap = () => {
        onUse();
        throw new Error("pool must not be touched before skill validation");
    };
    return { query: trap, connect: trap, end: async () => {} } as unknown as Pool;
}

function bootDeps(overrides: Partial<BootHarnessDeps>): BootHarnessDeps {
    return {
        core: {} as CoreRuntimeDeps,
        pool: explodingPool(() => {}),
        skillsDir: "/definitely/not/a/real/skills/dir",
        dbos: { executorId: "boot-test" } as DbosConfig,
        connectionBudget: {} as ConnectionBudgetConfig,
        logger: silentLogger,
        ...overrides,
    };
}

describe("bootHarness", () => {
    it("fails fast on an invalid skillsDir before any pool or launch work", async () => {
        let poolUsed = false;
        let beforeLaunchRan = false;

        await expect(
            bootHarness(
                bootDeps({
                    pool: explodingPool(() => {
                        poolUsed = true;
                    }),
                    beforeLaunch: () => {
                        beforeLaunchRan = true;
                    },
                }),
            ),
        ).rejects.toThrow(/skills/i);

        // Skill validation is step 2 — it throws before state-init (pool) and the
        // beforeLaunch hook (which precedes DBOS launch).
        expect(poolUsed).toBe(false);
        expect(beforeLaunchRan).toBe(false);
    });

    it("runs injected telemetry init before it throws on a bad skillsDir", async () => {
        let telemetryInited = false;

        await expect(
            bootHarness(
                bootDeps({
                    initTelemetry: () => {
                        telemetryInited = true;
                    },
                }),
            ),
        ).rejects.toThrow();

        expect(telemetryInited).toBe(true);
    });
});
