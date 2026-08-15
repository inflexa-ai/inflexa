import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import type { Browser } from "puppeteer-core";

import type { ThreadAgentResolver, UnregisteredThreadType } from "@inflexa-ai/harness";

import { createConversationAgent } from "../agents/conversation-agent.js";
import { createReportSessionAgent } from "../agents/report-session-agent.js";
import { createReportSessionRuntime } from "../app/report-session-runtime.js";
import { withSchema } from "../__tests__/setup/postgres.js";
import type { Scope } from "../auth/types.js";
import { unusedCitationResolver } from "../citations/__fixtures__/resolver.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import { setBrowserConnector, type ChromeConfig } from "../lib/chrome.js";
import type { AcquireEyes, EyesScope } from "../lib/eyes.js";
import { createThreadHistory } from "../memory/thread-history.js";
import { createThreadStore } from "../memory/thread-store.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import { upsertAnalysis } from "../state/analyses.js";
import type { ReportSessionStateStore } from "../state/report-session-state.js";
import type { ReportVersionStore } from "../state/report-versions.js";
import { makeToolContext } from "../tools/__fixtures__/tool-context.js";
import type { ReportSessionState, ReportSessionStateGateway, SessionStateLoad } from "../tools/report-authoring/authoring-tools.js";
import type { ExaminePageResult } from "../tools/report-session/index.js";
import type { StartReportSessionResult } from "../tools/start-report-session.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import { createThreadAgentResolver, resolveCompositionEyes, type CoreRuntime, type CoreRuntimeDeps } from "./assemble.js";
import type { AgentDefinition } from "../loop/types.js";
import type { ThreadStore, ThreadType } from "../memory/thread-store.js";

// A bare `AgentDefinition` stands in for the assembled conversation agent: the
// resolver only ever hands back the object the registry holds, so its internals
// never matter to resolution.
const conversationAgent: AgentDefinition = {
    id: "conversation",
    systemPrompt: "",
    model: "test/model",
    tools: [],
    maxIterations: 1,
};

// A bare `AgentDefinition` stands in for the assembled report agent, the same way
// `conversationAgent` stands in for the conversation agent.
const reportAgent: AgentDefinition = {
    id: "report-session",
    systemPrompt: "",
    model: "test/model",
    tools: [],
    maxIterations: 1,
};

// A registry that holds `conversation` and omits `report`. It exercises the
// refusal path: a resolver built over a registry with no entry for a type refuses.
function registry(): Partial<Record<ThreadType, AgentDefinition>> {
    return { conversation: conversationAgent };
}

describe("createThreadAgentResolver", () => {
    it("resolves the conversation type to the assembled conversation agent", () => {
        const result = createThreadAgentResolver(registry()).forThread("conversation");
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toBe(conversationAgent);
    });

    it("returns one identity across repeated resolution", () => {
        const resolver = createThreadAgentResolver(registry());
        const first = resolver.forThread("conversation");
        const second = resolver.forThread("conversation");
        // Singleton semantics: both calls surface the same object, so a handle
        // captured at construction stays the one every turn resolves.
        expect(first._unsafeUnwrap()).toBe(second._unsafeUnwrap());
    });

    it("resolves the report type to the same assembled singleton across two calls", () => {
        const resolver = createThreadAgentResolver({ conversation: conversationAgent, report: reportAgent });
        const first = resolver.forThread("report");
        const second = resolver.forThread("report");
        expect(first.isOk()).toBe(true);
        expect(first._unsafeUnwrap()).toBe(reportAgent);
        // Singleton semantics: both calls surface the same report agent, so a
        // handle captured at construction stays the one every report turn resolves.
        expect(first._unsafeUnwrap()).toBe(second._unsafeUnwrap());
    });

    it("refuses an unregistered type with a typed error carrying the type", () => {
        // Reduce the Result to whichever branch fired: a registered type would
        // yield its agent, `report` yields its refusal.
        const reduced = createThreadAgentResolver(registry())
            .forThread("report")
            .match(
                (agent) => agent,
                (refusal) => refusal,
            );
        expect(reduced).toEqual({ type: "unregistered_thread_type", threadType: "report" });
    });
});

describe("the report session handle", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("assemble_report_session");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("anchors a seeded report thread through the exposed handle", async () => {
        const analysisId = "analysis-assemble";
        const threadId = "thread-assemble";
        (await upsertAnalysis(pool, analysisId, null))._unsafeUnwrap();
        (await createThreadStore(pool).createThread({ threadId, analysisId, type: "report" }))._unsafeUnwrap();

        // The exposed handle is the runtime's turn-start anchor. The assignment proves
        // that the `CoreRuntime` field type accepts it; a drift fails tsc.
        const handle: CoreRuntime["reportSession"] = createReportSessionRuntime({ pool });

        const ready = await handle.ensureSessionState(threadId);
        expect(ready.outcome).toBe("ready");
    });
});

describe("the report host-read cap dep", () => {
    it("carries an optional host-read cap, thus an embedder can tune the report resolver", () => {
        // The assignment proves that the deps surface accepts the cap. `assembleCoreRuntime` builds the
        // report resolver factory over it, thus a drift or a dropped field fails this at the type level and
        // takes the one wiring point with it.
        const withCap: Pick<CoreRuntimeDeps, "reportHostReadCapBytes"> = { reportHostReadCapBytes: 8 * 1024 * 1024 };
        expect(withCap.reportHostReadCapBytes).toBeDefined();
        // The cap is optional, thus the OSS default omits it and the resolver uses its 16 MiB default.
        const without: Pick<CoreRuntimeDeps, "reportHostReadCapBytes"> = {};
        expect(without.reportHostReadCapBytes).toBeUndefined();
    });
});

/**
 * The fixtures of the eyes cases.
 *
 * `assembleCoreRuntime` registers the durable workflows with DBOS, thus a case drives the eyes resolution
 * alone, the same as the thread-resolver cases above. Each case resolves the eyes of one composition, builds
 * the report agent over that answer the way the assembly does, and looks at one page through the eyes tool
 * of the roster.
 */
const EYES_ANALYSIS_ID = "analysis-eyes";

/**
 * The endpoint of each case that connects.
 *
 * The connection cache holds one browser for each endpoint over the whole run. Thus each case names its own
 * endpoint, and no case reads the browser that another case left in the cache.
 */
const STATIC_ENDPOINT = "http://assemble-static.test:9222";
const SEAM_ENDPOINT = "http://assemble-seam.test:9222";
const UNUSED_ENDPOINT = "http://assemble-unused.test:9222";

/** Each root that a case made. The cleanup removes them after the suite. */
const eyesRoots: string[] = [];

/** The restore of the connect operation that a case replaced. */
let restoreConnector: (() => void) | undefined;

afterEach(() => {
    restoreConnector?.();
    restoreConnector = undefined;
});

afterAll(async () => {
    for (const root of eyesRoots) {
        await rm(root, { recursive: true, force: true });
    }
});

/** Make a temp workspace root that holds the rendered page of one thread, thus a look finds a page. */
async function makeEyesRoot(threadId: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "assemble-eyes-"));
    eyesRoots.push(root);
    const dir = join(root, "report-sessions", threadId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), "<html><body>report</body></html>", "utf8");
    return root;
}

/**
 * A gateway whose thread holds a rendered hash.
 *
 * The page and the hash both exist, thus the eyes of the composition are the one condition that a case
 * varies. A look that finds no browser stops before this gateway.
 */
function eyesGateway(): ReportSessionStateGateway {
    const state: ReportSessionState = { document: { title: "", sections: [] }, snapshot: { artifacts: {} } };
    return {
        load: (): Promise<SessionStateLoad> => Promise.resolve({ outcome: "found", state, analysisId: EYES_ANALYSIS_ID, token: null, seenDocumentHash: null }),
        persist: () => Promise.resolve({ outcome: "persisted" }),
        stampRendered: () => Promise.resolve({ outcome: "stamped" }),
        stampSeen: () => Promise.resolve({ outcome: "stamped" }),
    };
}

/**
 * Make a browser that no process backs, and give the screenshot that its one page returns.
 *
 * The capture reads the connected flag, it registers the disconnect listener, it opens one context, it sizes
 * one page, it emulates the media features of that page, it drives the page, and it closes the context. The
 * fake carries those members alone. The two-step assertion names the type of puppeteer, because a fake of a
 * class with private members is no structural match.
 */
function fakeBrowser(screenshot: string): Browser {
    const page = {
        on: () => {},
        setViewport: () => Promise.resolve(),
        emulateMediaFeatures: () => Promise.resolve(),
        goto: () => Promise.resolve(),
        evaluate: () => Promise.resolve(),
        screenshot: () => Promise.resolve(screenshot),
    };
    const fake = {
        connected: true,
        on: () => {},
        wsEndpoint: () => "ws://fake",
        createBrowserContext: () =>
            Promise.resolve({
                newPage: () => Promise.resolve(page),
                close: () => Promise.resolve(),
            }),
    };
    return fake as unknown as Browser;
}

/**
 * Build the report agent over the eyes of one composition, the same wiring as the assembly.
 *
 * A case runs the eyes tool alone, and that tool reads the gateway, the workspace root, the chrome config,
 * and the eyes. Each of the four is real here. No factory of the roster reads one of the other deps at
 * construction. Thus an empty stub stands for each of them, and no case reaches the gap between a stub and
 * its interface.
 */
function reportAgentOver(eyes: AcquireEyes | undefined, chrome: ChromeConfig, root: string): AgentDefinition {
    return createReportSessionAgent({
        model: "test/model",
        pool: {} as Pool,
        embedding: {} as EmbeddingProvider,
        workspaceFs: {} as WorkspaceFilesystem,
        gateway: eyesGateway(),
        resolveWorkspaceRoot: () => root,
        store: {} as ReportVersionStore,
        threads: {} as Pick<ThreadStore, "getThread">,
        chrome,
        derivations: {} as Pick<ReportSessionStateStore, "appendDerivation">,
        ...(eyes ? { eyes } : {}),
    });
}

/** Look at the page of one thread through the eyes tool of a built agent. */
async function look(agent: AgentDefinition, threadId: string): Promise<ExaminePageResult> {
    const found = agent.tools.filter((each) => each.id === "examine_page");
    // The roster holds one eyes tool. A wiring that drops it empties this list, thus the assertion fails
    // here and no line below reads an absent member.
    expect(found).toHaveLength(1);
    const [tool] = found;
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId: EYES_ANALYSIS_ID, threadId };
    const outcome = await tool.execute({}, { ...ctx, session: { ...ctx.session, scope } });
    // The roster types each tool as `Tool<unknown, unknown>`. The id above selects the one factory that
    // makes the eyes tool, thus the ok value is the outcome of that tool and a case reads its arm by name.
    return outcome._unsafeUnwrap() as ExaminePageResult;
}

describe("the eyes of the composition", () => {
    it("gives no eyes when the composition binds no seam and the config names no browser", async () => {
        const threadId = "thread-no-eyes";
        const root = await makeEyesRoot(threadId);
        const chrome: ChromeConfig = {};

        const result = await look(reportAgentOver(resolveCompositionEyes(undefined, chrome), chrome, root), threadId);

        // The page exists and the row holds a rendered hash, thus the absent browser is the one condition
        // that stops the look.
        expect(result.outcome).toBe("no-browser");
    });

    it("wraps the configured endpoint into the static realization when the composition binds no seam", async () => {
        const threadId = "thread-static";
        const root = await makeEyesRoot(threadId);
        const chrome: ChromeConfig = { browserUrl: STATIC_ENDPOINT };
        const connected: string[] = [];
        restoreConnector = setBrowserConnector((browserUrl) => {
            connected.push(browserUrl);
            return Promise.resolve(fakeBrowser("STATICPNG"));
        });

        const result = await look(reportAgentOver(resolveCompositionEyes(undefined, chrome), chrome, root), threadId);

        expect(result.outcome).toBe("examined");
        // The static realization gives the configured endpoint, thus the look reaches that browser.
        expect(connected).toEqual([STATIC_ENDPOINT]);
    });

    it("passes the bound seam, and it wraps no config", async () => {
        const threadId = "thread-seam";
        const root = await makeEyesRoot(threadId);
        // The config names a browser too. Thus the case separates the seam of the embedder from the wrap of
        // the config, and only the endpoint of the eyes that answered reaches a connection.
        const chrome: ChromeConfig = { browserUrl: UNUSED_ENDPOINT };
        const acquired: EyesScope[] = [];
        const released: string[] = [];
        const seam: AcquireEyes = (scope) => {
            acquired.push(scope);
            return Promise.resolve({
                browserUrl: SEAM_ENDPOINT,
                release: () => {
                    released.push(SEAM_ENDPOINT);
                    return Promise.resolve();
                },
            });
        };
        const connected: string[] = [];
        restoreConnector = setBrowserConnector((browserUrl) => {
            connected.push(browserUrl);
            return Promise.resolve(fakeBrowser("SEAMPNG"));
        });

        const result = await look(reportAgentOver(resolveCompositionEyes(seam, chrome), chrome, root), threadId);

        expect(result.outcome).toBe("examined");
        // The seam answered the look, thus the configured endpoint reached no connection at all.
        expect(connected).toEqual([SEAM_ENDPOINT]);
        // The scope carries the analysis and the root of the call, thus a realization mounts the same tree.
        expect(acquired).toEqual([{ analysisId: EYES_ANALYSIS_ID, workspaceRoot: root }]);
        expect(released).toEqual([SEAM_ENDPOINT]);
    });
});

/**
 * The fixtures of the start-tool case.
 *
 * The assembly resolves the eyes one time, and the conversation agent takes that answer. The case builds the
 * agent over one resolution, the same wiring as the assembly. It starts a session through the tool of the
 * roster.
 */
const START_ANALYSIS_ID = "analysis-start";

/** The endpoint of the seam of the start-tool case. The start tool opens no lease, thus nothing connects. */
const START_ENDPOINT = "http://assemble-start.test:9222";

/** The smallest brief that the tool accepts. The two optional fields add nothing to the eyes case. */
const START_BRIEF = {
    objective: "Explain the sample quality outcome",
    audience: "The lab lead",
    angle: "The samples that the study keeps",
};

/**
 * Build the conversation agent over the eyes of one composition, the same wiring as the assembly.
 *
 * The case runs the start tool alone, and that tool reads the pool, the anchor, the chrome config, and the
 * eyes. Each of the four is real here. No factory of the roster reads one of the other deps at construction,
 * thus an empty stub stands for each of them.
 */
function conversationAgentOver(eyes: AcquireEyes | undefined, chrome: ChromeConfig, pool: Pool): AgentDefinition {
    return createConversationAgent({
        provider: {} as ChatProvider,
        utilityProvider: {} as ChatProvider,
        pool,
        embedding: {} as EmbeddingProvider,
        workspaceFs: {} as WorkspaceFilesystem,
        model: "test/model",
        utilityModel: "test/utility-model",
        executeAnalysisWorkflow: (async () => {
            throw new Error("not used at composition time");
        }) as never,
        anchorReportSession: createReportSessionRuntime({ pool }).ensureSessionState,
        resolveWorkspaceRoot: (id: string) => join("/sessions", id),
        runAuthorizer: {} as RunAuthorizer,
        runLauncher: {} as RunLauncher,
        createPreviewPublisher: (async () => {
            throw new Error("not used at composition time");
        }) as never,
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        templatesDir: "/templates",
        skillsDir: "/skills",
        chrome,
        citationResolver: unusedCitationResolver,
        ...(eyes ? { eyes } : {}),
    });
}

/**
 * Seed the parent conversation of one start-tool case. The spawn refuses an empty transcript, thus the parent
 * carries one turn.
 */
async function seedParent(pool: Pool, analysisId: string, parentThreadId: string): Promise<void> {
    (await upsertAnalysis(pool, analysisId, null))._unsafeUnwrap();
    (await createThreadStore(pool).createThread({ threadId: parentThreadId, analysisId, title: "Parent" }))._unsafeUnwrap();
    (
        await createThreadHistory(pool).appendTurn(parentThreadId, {
            modelMessages: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                { role: "assistant", content: [{ type: "text", text: "hello" }] },
            ],
            displayMessages: [],
        })
    )._unsafeUnwrap();
}

/** Start a report session through the start tool of a built agent. */
async function startSession(agent: AgentDefinition, analysisId: string, parentThreadId: string): Promise<StartReportSessionResult> {
    const found = agent.tools.filter((each) => each.id === "start_report_session");
    // The roster holds one start tool. A wiring that drops it empties this list, thus the assertion fails
    // here and no line below reads an absent member.
    expect(found).toHaveLength(1);
    const [tool] = found;
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId, threadId: parentThreadId };
    const outcome = await tool.execute(START_BRIEF, { ...ctx, session: { ...ctx.session, scope } });
    // The roster types each tool as `Tool<unknown, unknown>`. The id above selects the one factory that
    // makes the start tool. Thus the ok value is the outcome of that tool.
    return outcome._unsafeUnwrap() as StartReportSessionResult;
}

describe("the eyes of the start tool", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("assemble_start_report_session");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("carries the resolved seam into the start tool of the conversation agent", async () => {
        const parentThreadId = "thread-start-parent";
        await seedParent(pool, START_ANALYSIS_ID, parentThreadId);
        // The config names no browser, thus the bound seam is the one route to a look.
        const chrome: ChromeConfig = {};
        const seam: AcquireEyes = () => Promise.resolve({ browserUrl: START_ENDPOINT, release: () => Promise.resolve() });

        const result = await startSession(conversationAgentOver(resolveCompositionEyes(seam, chrome), chrome, pool), START_ANALYSIS_ID, parentThreadId);

        // A composition with no route refuses here, thus the started arm says that the seam reached the tool.
        expect(result.outcome).toBe("started");
    });
});

/**
 * The fixtures of the one-answer case.
 *
 * The assembly resolves the eyes one time, and two consumers read that answer. The case builds the agent that
 * looks at a page and the tool that starts a session over one resolved value.
 */
const BOTH_ANALYSIS_ID = "analysis-both";

/** The endpoint of the seam of the one-answer case. Each case names its own endpoint, thus no case shares a browser. */
const BOTH_ENDPOINT = "http://assemble-both.test:9222";

describe("one resolved answer", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("assemble_one_resolved_answer");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("serves the agent that looks at a page and the tool that starts a session", async () => {
        const parentThreadId = "thread-both-parent";
        const lookThreadId = "thread-both-look";
        const root = await makeEyesRoot(lookThreadId);
        await seedParent(pool, BOTH_ANALYSIS_ID, parentThreadId);

        // The config names no browser, thus the resolved seam is the one route of both consumers.
        const chrome: ChromeConfig = {};
        const seam: AcquireEyes = () => Promise.resolve({ browserUrl: BOTH_ENDPOINT, release: () => Promise.resolve() });
        const connected: string[] = [];
        restoreConnector = setBrowserConnector((browserUrl) => {
            connected.push(browserUrl);
            return Promise.resolve(fakeBrowser("BOTHPNG"));
        });

        // The one resolution. Each consumer below reads this value, thus a second resolution never runs.
        const eyes = resolveCompositionEyes(seam, chrome);
        const looked = await look(reportAgentOver(eyes, chrome, root), lookThreadId);
        const started = await startSession(conversationAgentOver(eyes, chrome, pool), BOTH_ANALYSIS_ID, parentThreadId);

        expect(looked.outcome).toBe("examined");
        // The look reached the endpoint of the resolved seam, thus the agent read that answer.
        expect(connected).toEqual([BOTH_ENDPOINT]);
        // The config names no browser, thus the started arm says that the tool read the same answer.
        expect(started.outcome).toBe("started");
    });
});

describe("the barrel resolution surface", () => {
    it("exports the resolver type, thus an embedder needs no deep path", () => {
        // The assignment proves that the barrel type accepts the built resolver. A
        // drift or a dropped export fails it at the type level.
        const resolver: ThreadAgentResolver = createThreadAgentResolver(registry());
        const outcome = resolver.forThread("report");
        expect(outcome.isErr()).toBe(true);
        // The barrel error type is the refusal type. Thus the error branch assigns to it.
        const refusal: UnregisteredThreadType | undefined = outcome.isErr() ? outcome.error : undefined;
        expect(refusal).toEqual({ type: "unregistered_thread_type", threadType: "report" });
    });
});
