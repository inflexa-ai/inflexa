import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../../__tests__/setup/logger.js";
import type { Pool } from "pg";

import { SANDBOX_AGENT_META } from "../../agents/sandbox/index.js";
import { bootHarness, type BootHarnessDeps } from "../boot.js";
import type { ConversationAssemblyDeps, CoreRuntimeDeps } from "../assemble.js";
import {
    poolDouble,
    stubChatProvider,
    stubEmbeddingProvider,
    stubRunAuthorizer,
    stubRunLauncher,
    stubSandboxClient,
    stubWorkspaceFilesystem,
} from "../../lib/test/doubles.js";

/** A pool that fails loudly if boot reaches state-init / the budget guard. */
function explodingPool(onUse: () => void): Pool {
    const trap = () => {
        onUse();
        throw new Error("exploding pool: boot reached state init");
    };
    // SAFETY: a hand-built double of the seam under test — the test drives only the members this object declares, so the missing members are never read.
    return poolDouble(trap, {
        connect: trap,
        end: () => {
            return Promise.resolve();
        },
    });
}

/** The loud answer of a member boot never reaches: every case here stops before the assembly step. */
function unstubbed(where: string): never {
    throw new Error(`${where}: boot fails before the assembly reads the core`);
}

/** The core bag of the boot deps. No case reaches the assembly, so each member stands unwired. */
function unwiredCore(): CoreRuntimeDeps {
    const conversation: ConversationAssemblyDeps = {
        provider: stubChatProvider(),
        utilityProvider: stubChatProvider(),
        pool: poolDouble(),
        embedding: stubEmbeddingProvider(),
        workspaceFs: stubWorkspaceFilesystem(),
        model: "test/model",
        utilityModel: "test/utility-model",
        resolveWorkspaceRoot: (id: string) => Promise.resolve(join("/sessions", id)),
        runAuthorizer: stubRunAuthorizer(),
        runLauncher: stubRunLauncher(),
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        skillsDir: "/skills",
        chrome: {},
    };
    return {
        conversation,
        workflows: {
            sandboxStep: {
                pool: poolDouble(),
                provider: stubChatProvider(),
                embedding: stubEmbeddingProvider(),
                sandboxClient: stubSandboxClient(),
                artifactRegistry: {
                    register: () => unstubbed("ArtifactRegistry.register"),
                    sync: () => unstubbed("ArtifactRegistry.sync"),
                },
                workspaceFs: stubWorkspaceFilesystem(),
                resolveWorkspaceRoot: (id: string) => Promise.resolve(join("/sessions", id)),
                model: "test/model",
                buildAgent: () => unstubbed("SandboxStepDeps.buildAgent"),
                resolveWritePrefix: (stepInput) => Promise.resolve(join("/sessions", stepInput.runId, stepInput.stepId)),
            },
            buildExecuteAnalysis: (sandboxStep) => ({
                pool: poolDouble(),
                provider: stubChatProvider(),
                embedding: stubEmbeddingProvider(),
                sandboxStepCallable: sandboxStep,
                resolveWorkspaceRoot: (id: string) => Promise.resolve(join("/sessions", id)),
                synthesisModel: "test/model",
                bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
                runCharge: {
                    open: () => unstubbed("RunCharge.open"),
                    close: () => unstubbed("RunCharge.close"),
                },
                runAuthorizer: stubRunAuthorizer(),
            }),
            dataProfile: {
                provider: stubChatProvider(),
                pool: poolDouble(),
                sandboxClient: stubSandboxClient(),
                workspaceFs: stubWorkspaceFilesystem(),
                resolveWorkspaceRoot: (id: string) => Promise.resolve(join("/sessions", id)),
                model: "test/model",
                runAuthorizer: stubRunAuthorizer(),
                bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
                embedding: stubEmbeddingProvider(),
                skillsDir: "/skills",
            },
        },
    };
}

function bootDeps(overrides: Partial<BootHarnessDeps>): BootHarnessDeps {
    return {
        core: unwiredCore(),
        pool: explodingPool(() => {}),
        skillsDir: "/definitely/not/a/real/skills/dir",
        dbos: {
            dbHost: "boot.test",
            dbPort: "5432",
            dbName: "cortex",
            dbUser: "cortex",
            dbPassword: "secret",
            dbSslMode: "disable",
            appName: "cortex",
            adminPort: "39001",
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
            // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the assertion's grammar: the expected output shape has no builtin matcher.
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
