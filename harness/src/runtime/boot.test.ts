import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../__tests__/setup/logger.js";
import type { Pool } from "pg";

import { SANDBOX_AGENT_META } from "../agents/sandbox/index.js";
import { bootHarness, type BootHarnessDeps } from "./boot.js";
import type { CoreRuntimeDeps } from "./assemble.js";
import type { DbosConfig } from "./dbos.js";
import type { ConnectionBudgetConfig } from "./connection-budget.js";

/** A pool that fails loudly if boot reaches state-init / the budget guard. */
function explodingPool(onUse: () => void): Pool {
    const trap = () => {
        onUse();
        throw new Error("exploding pool: boot reached state init");
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

const SANDBOX_SKILLS = [...new Set(Object.values(SANDBOX_AGENT_META).flatMap((meta) => meta.skills))];

const tempRoots: string[] = [];

/** A skills tree holding a readable `SKILL.md` for each named pack, and nothing else. */
async function skillsDirWith(packs: readonly string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "boot-skills-"));
    tempRoots.push(root);
    for (const pack of packs) {
        await mkdir(join(root, pack), { recursive: true });
        await writeFile(join(root, pack, "SKILL.md"), "# pack\n");
    }
    return root;
}

afterAll(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

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

    it("clears skill validation once every declared pack resolves", async () => {
        let poolUsed = false;

        await expect(
            bootHarness(
                bootDeps({
                    skillsDir: await skillsDirWith(SANDBOX_SKILLS),
                    pool: explodingPool(() => {
                        poolUsed = true;
                    }),
                }),
            ),
        ).rejects.toThrow(/boot reached state init/);

        expect(poolUsed).toBe(true);
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
