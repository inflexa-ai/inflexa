import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../../__tests__/setup/logger.js";
import { Pool } from "pg";

import { SANDBOX_AGENT_META } from "../../agents/sandbox/index.js";
import { makeFakeWorkspaceFs } from "../../agents/sandbox/__fixtures__/deps.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import { constructionWorkflows, refuseEmbedding, refuseRunLauncher } from "../__fixtures__/construction-core.js";
import { unusedChatProvider } from "../../providers/__fixtures__/chat-provider.js";
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
            conversation: {
                provider: unusedChatProvider(),
                utilityProvider: unusedChatProvider(),
                pool: new Pool(),
                embedding: refuseEmbedding(),
                workspaceFs: makeFakeWorkspaceFs(),
                model: "test/model",
                utilityModel: "test/utility-model",
                resolveWorkspaceRoot: async (id: string) => join("/sessions", id),
                runAuthorizer: createLocalRunAuthorizer(),
                runLauncher: refuseRunLauncher(),
                bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
                skillsDir: "/skills",
                chrome: {},
            },
            workflows: constructionWorkflows(),
        },
        pool: explodingPool(() => {}),
        skillsDir: "/definitely/not/a/real/skills/dir",
        dbos: {
            dbHost: "",
            dbPort: "",
            dbName: "",
            dbUser: "",
            dbPassword: "",
            dbSslMode: "disable",
            appName: "boot-test",
            adminPort: "",
            executorId: "boot-test",
        },
        connectionBudget: {},
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
        ).rejects.toThrow("SKILLS_DIR");

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
        ).rejects.toThrow("boot reached state init");

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
