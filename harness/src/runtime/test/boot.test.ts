import { describe, expect, it } from "bun:test";
import { silentLogger } from "../../__tests__/setup/logger.js";
import { Pool } from "pg";

import { createInMemoryCatalog } from "../../catalog/memory.js";
import { conversationDeps, constructionSandbox, constructionWorkflows } from "../__fixtures__/construction-core.js";
import { bootHarness, type BootHarnessDeps } from "../boot.js";

import type { Querier } from "../../state/db.js";

/** A pool that fails loudly if boot reaches state-init / the budget guard. The driver object carries `options`; nothing dials the server. */
function explodingPool(onUse: () => void): Querier & Pick<Pool, "connect" | "end" | "options"> {
    const trap = () => {
        onUse();
        throw new Error("exploding pool: boot reached state init");
    };
    return Object.assign(new Pool(), { query: trap, connect: trap, end: async () => {} });
}

function bootDeps(overrides: Partial<BootHarnessDeps>): BootHarnessDeps {
    return {
        core: {
            conversation: conversationDeps(),
            workflows: constructionWorkflows(),
            sandbox: constructionSandbox(),
            catalog: createInMemoryCatalog(),
        },
        pool: explodingPool(() => {}),
        dbos: {
            dbHost: "",
            dbPort: "",
            dbName: "",
            dbUser: "",
            dbPassword: "",
            dbSslMode: "disable",
            appName: "boot-test",
            executorId: "boot-test",
        },
        connectionBudget: {},
        logger: silentLogger,
        ...overrides,
    };
}

describe("bootHarness", () => {
    it("reaches state init first, before the beforeLaunch hook", async () => {
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
        ).rejects.toThrow("boot reached state init");

        expect(poolUsed).toBe(true);
        expect(beforeLaunchRan).toBe(false);
    });

    it("runs injected telemetry init before it throws at state init", async () => {
        let telemetryInited = false;

        await expect(
            bootHarness(
                bootDeps({
                    initTelemetry: () => {
                        telemetryInited = true;
                    },
                }),
            ),
        ).rejects.toThrow("boot reached state init");

        expect(telemetryInited).toBe(true);
    });
});
