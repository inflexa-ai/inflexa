/**
 * The tests of the eyes tool.
 *
 * Each test drives the tool through `execute` with a temp workspace root, an in-memory gateway, and a stub
 * capture or a fake eyes seam. The chrome connection has its own prior art. Thus these tests cover the tool
 * orchestration alone: the transport precedence, the lease of one look, and the seen-hash copy.
 *
 * A look through a lease runs the shared capture, thus these tests replace the connect operation with a fake
 * browser. Each test that connects names its own endpoint, because the cache holds one browser for each
 * endpoint.
 *
 * A test that hangs a seam call shortens the two budgets of the tool. Thus the deadline of that call expires
 * inside the test, and the test reads the outcome that an expiry gives.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "puppeteer-core";

import type { Scope } from "../../auth/types.js";
import { setBrowserConnector } from "../../lib/chrome.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { AcquireEyes, EyesLease, EyesScope } from "../../lib/eyes.js";
import type { Logger } from "../../lib/logger.js";
import type {
    ReportSessionState,
    ReportSessionStateGateway,
    SeenStampResult,
    SessionStateLoad,
    SessionStatePersist,
    StampResult,
} from "../report-authoring/authoring-tools.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { readToolResultImage, type ToolContext } from "../define-tool.js";
import { createExaminePageTool, type CapturePage, type ExaminePageResult, type PageCapture } from "./examine-page.js";

const DEFAULT_ANALYSIS_ID = "analysis-001";

/** Each root that a test made. The cleanup removes them after the suite. */
const roots: string[] = [];

afterAll(async () => {
    for (const root of roots) {
        await rm(root, { recursive: true, force: true });
    }
});

/** Make a fresh temp directory as a workspace root. */
async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "examine-page-"));
    roots.push(root);
    return root;
}

/** Write the rendered page under the session directory, thus a look finds a page. */
async function writePage(root: string, threadId: string): Promise<void> {
    const dir = join(root, "report-sessions", threadId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), "<html><body>report</body></html>", "utf8");
}

interface FakeRow {
    state: ReportSessionState;
    analysisId: string;
    rendered: string | null;
    seen: string | null;
}

interface FakeGateway extends ReportSessionStateGateway {
    seed(threadId: string, rendered: string | null): void;
    seenOf(threadId: string): string | null;
}

function makeFakeGateway(): FakeGateway {
    const rows = new Map<string, FakeRow>();
    const emptyState: ReportSessionState = { document: { title: "", sections: [] }, snapshot: { artifacts: {} } };
    return {
        seed(threadId, rendered): void {
            rows.set(threadId, { state: emptyState, analysisId: DEFAULT_ANALYSIS_ID, rendered, seen: null });
        },
        seenOf(threadId): string | null {
            return rows.get(threadId)?.seen ?? null;
        },
        load(threadId): Promise<SessionStateLoad> {
            const row = rows.get(threadId);
            if (row === undefined) {
                return Promise.resolve({ outcome: "absent" });
            }
            return Promise.resolve({ outcome: "found", state: row.state, analysisId: row.analysisId, token: null, seenDocumentHash: row.seen });
        },
        persist(): Promise<SessionStatePersist> {
            return Promise.resolve({ outcome: "persisted" });
        },
        stampRendered(threadId, hash): Promise<StampResult> {
            const row = rows.get(threadId);
            if (row === undefined) {
                return Promise.resolve({ outcome: "absent" });
            }
            row.rendered = hash;
            return Promise.resolve({ outcome: "stamped" });
        },
        stampSeen(threadId): Promise<SeenStampResult> {
            const row = rows.get(threadId);
            if (row === undefined) {
                return Promise.resolve({ outcome: "absent" });
            }
            if (row.rendered === null) {
                // No preview stamped a rendered hash, thus the seen stamp finds none to copy.
                return Promise.resolve({ outcome: "no-rendered" });
            }
            row.seen = row.rendered;
            return Promise.resolve({ outcome: "stamped" });
        },
    };
}

/** A tool context whose scope names a report thread. */
function ctxForThread(threadId: string): ToolContext {
    const { ctx } = makeToolContext();
    const scope: Scope = { kind: "analysis", analysisId: DEFAULT_ANALYSIS_ID, threadId };
    return { ...ctx, session: { ...ctx.session, scope } };
}

/** A fake eyes seam, plus the record of what the tool asked of it. */
interface FakeEyes {
    readonly acquire: AcquireEyes;
    /** The scope of each acquire, in call order. */
    readonly acquired: EyesScope[];
    /** The endpoint of each released lease, in call order. */
    readonly released: string[];
}

/**
 * Make a fake eyes seam over one endpoint.
 *
 * `failAcquire` refuses the acquire, and `failRelease` refuses the release. A refused release still records
 * the call, thus a test reads that the tool released the lease and that the fault changed no outcome.
 *
 * `hangAcquire` and `hangRelease` give a promise that never settles. A realization that hangs while it starts
 * or stops a browser reads the same. Thus a test drives the deadline of the tool and never a slow clock.
 */
function makeFakeEyes(options: { browserUrl: string; failAcquire?: Error; failRelease?: Error; hangAcquire?: boolean; hangRelease?: boolean }): FakeEyes {
    const acquired: EyesScope[] = [];
    const released: string[] = [];
    const neverSettles = <T>(): Promise<T> => new Promise<T>(() => undefined);
    return {
        acquired,
        released,
        acquire: (scope) => {
            acquired.push(scope);
            if (options.failAcquire !== undefined) {
                return Promise.reject(options.failAcquire);
            }
            if (options.hangAcquire === true) {
                return neverSettles<EyesLease>();
            }
            return Promise.resolve({
                browserUrl: options.browserUrl,
                release: () => {
                    released.push(options.browserUrl);
                    if (options.hangRelease === true) {
                        return neverSettles<void>();
                    }
                    return options.failRelease !== undefined ? Promise.reject(options.failRelease) : Promise.resolve();
                },
            });
        },
    };
}

/**
 * Make a browser that no process backs, and give the screenshot that its one page returns.
 *
 * The capture reads the connected flag, it registers the disconnect listener, it opens one context, it sizes
 * one page, it emulates the media features of that page, it drives the page, and it closes the context. The
 * fake carries those members alone, thus no call of the capture reaches the gap between the fake and the
 * class of puppeteer.
 */
function makeFakeBrowser(screenshot: string): Browser {
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
 * The endpoint of each test that connects.
 *
 * The connection cache holds one browser for each endpoint over the whole run. Thus each test names its own
 * endpoint, and no test reads the browser that another test left in the cache.
 */
const LEASE_ENDPOINT = "http://examine-lease.test:9222";
const CAPTURE_FAULT_ENDPOINT = "http://examine-capture-fault.test:9222";
const RELEASE_FAULT_ENDPOINT = "http://examine-release-fault.test:9222";
const RELEASE_HANG_ENDPOINT = "http://examine-release-hang.test:9222";
const CONFIGURED_ENDPOINT = "http://examine-configured.test:9222";

/**
 * The budget that a test gives to a seam call that hangs.
 *
 * The tool holds a budget of seconds for a real cold start. A test that waits for it would stall the run,
 * thus the test seam of the deps shortens the budget to this value.
 */
const HUNG_DEADLINE_MS = 25;

/**
 * Make a logger that records the message of each warn record.
 *
 * A failed release changes no outcome of the look, thus the log is its whole record. The fake keeps its own
 * identity through `with` and `named`, thus a record of the tool reaches this list.
 */
function recordingLogger(): { logger: Logger; warns: string[] } {
    const warns: string[] = [];
    const logger: Logger = {
        ...createNoopLogger(),
        warn: (msg) => {
            warns.push(msg);
        },
        with: () => logger,
        named: () => logger,
    };
    return { logger, warns };
}

/** The restore of the connect operation that a test replaced. */
let restoreConnector: (() => void) | undefined;

afterEach(() => {
    restoreConnector?.();
    restoreConnector = undefined;
});

describe("the no-browser outcome", () => {
    it("reports the absent browser up front when the composition binds no capture seam, no eyes seam, and no endpoint, and stamps nothing", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        // The page and the rendered hash both exist, thus only the absent browser stops the look.
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {} });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("no-browser");
        if (result.outcome === "no-browser") {
            expect(result.detail).toContain("no browser");
        }
        // No eyes saw the page, thus the seen hash stays null and the record still refuses.
        expect(gateway.seenOf(threadId)).toBeNull();
    });

    it("looks at the page when the config names a browser, thus the arm keys on the composition and not on the connection", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        const stub: PageCapture = { screenshotBase64: "BASE64PNG", coverage: "full", consoleErrors: [], failedRequests: [] };
        const capture: CapturePage = () => Promise.resolve(stub);
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: { browserUrl: "http://localhost:9222" }, capture });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("examined");
    });
});

describe("the no-page outcome", () => {
    it("gives a no-page outcome when no preview wrote the page, and stamps nothing", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", null);
        const capture: CapturePage = () => Promise.reject(new Error("the capture must not run when no page exists"));
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, capture });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(result.outcome).toBe("no-page");
        // No look ran, thus the seen hash stays null.
        expect(gateway.seenOf("t1")).toBeNull();
    });
});

describe("the missed stamp", () => {
    it("directs a new preview when the row holds no rendered hash, and stamps no seen hash", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        // The preview stamped no rendered hash, thus the seen stamp finds none to copy.
        gateway.seed(threadId, null);
        const stub: PageCapture = { screenshotBase64: "BASE64PNG", coverage: "full", consoleErrors: [], failedRequests: [] };
        const capture: CapturePage = () => Promise.resolve(stub);
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, capture });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("missed-stamp");
        // The seen hash stays null, thus the record still refuses until a new preview stamps a rendered hash.
        expect(gateway.seenOf(threadId)).toBeNull();
    });
});

describe("the seen-stamp copy", () => {
    it("captures the page, gives the faults on the JSON and the picture on the image path, and copies the rendered hash onto the seen hash", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");

        let capturedUrl: string | undefined;
        const stub: PageCapture = {
            screenshotBase64: "BASE64PNG",
            coverage: "full",
            consoleErrors: ["boom"],
            failedRequests: [{ url: "assets/x.png", reason: "net" }],
        };
        const capture: CapturePage = (url) => {
            capturedUrl = url;
            return Promise.resolve(stub);
        };
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, capture });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("examined");
        if (result.outcome === "examined") {
            expect(result.coverage).toBe("full");
            expect(result.consoleErrors).toEqual(["boom"]);
            expect(result.failedRequests).toEqual([{ url: "assets/x.png", reason: "net" }]);
            expect(result.pagePath).toBe(join("report-sessions", threadId, "index.html"));
        }
        // The screenshot rides the image path, thus the model sees the picture.
        expect(readToolResultImage(result)).toEqual({ base64: "BASE64PNG", mediaType: "image/png" });
        // The JSON text holds no bytes, thus the picture never reaches the JSON by accident.
        expect(JSON.stringify(result)).not.toContain("BASE64PNG");
        // The tool navigates to the page file through a file URL.
        expect(capturedUrl).toBeDefined();
        expect(fileURLToPath(capturedUrl!)).toBe(join(root, "report-sessions", threadId, "index.html"));
        // The look copies the rendered hash onto the seen hash, thus the record lets the current draft record.
        expect(gateway.seenOf(threadId)).toBe("rendered-hash");
    });

    it("carries the viewport coverage of a degraded picture, and stamps the seen hash as a full look does", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");

        // The browser refused the full-page bitmap, thus the capture gives the window alone.
        const stub: PageCapture = { screenshotBase64: "VIEWPORTPNG", coverage: "viewport", consoleErrors: [], failedRequests: [] };
        const capture: CapturePage = () => Promise.resolve(stub);
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, capture });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("examined");
        if (result.outcome === "examined") {
            // The coverage rides the JSON, thus the agent reads that the picture shows the window alone.
            expect(result.coverage).toBe("viewport");
        }
        expect(readToolResultImage(result)).toEqual({ base64: "VIEWPORTPNG", mediaType: "image/png" });
        // The agent saw the current document, thus the degraded look counts and the record path stays open.
        expect(gateway.seenOf(threadId)).toBe("rendered-hash");
    });
});

describe("the lease of one look", () => {
    it("acquires one lease, captures against the endpoint of that lease, and releases the lease", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        const connected: string[] = [];
        restoreConnector = setBrowserConnector((browserUrl) => {
            connected.push(browserUrl);
            return Promise.resolve(makeFakeBrowser("LEASEPNG"));
        });
        const eyes = makeFakeEyes({ browserUrl: LEASE_ENDPOINT });
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, eyes: eyes.acquire });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("examined");
        expect(readToolResultImage(result)).toEqual({ base64: "LEASEPNG", mediaType: "image/png" });
        // The scope carries the analysis and the root of this call, thus a realization mounts the same tree.
        expect(eyes.acquired).toEqual([{ analysisId: DEFAULT_ANALYSIS_ID, workspaceRoot: root }]);
        // The capture reached the endpoint of the lease, and not the endpoint of the chrome config.
        expect(connected).toEqual([LEASE_ENDPOINT]);
        expect(eyes.released).toEqual([LEASE_ENDPOINT]);
        expect(gateway.seenOf(threadId)).toBe("rendered-hash");
    });

    it("releases the lease when the capture fails, and gives the typed capture failure", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        // The browser of the lease refuses the connection, thus the capture fails after the acquire.
        restoreConnector = setBrowserConnector(() => Promise.reject(new Error("connect refused")));
        const eyes = makeFakeEyes({ browserUrl: CAPTURE_FAULT_ENDPOINT });
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, eyes: eyes.acquire });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("capture-failed");
        if (result.outcome === "capture-failed") {
            expect(result.detail).toContain("connect refused");
        }
        expect(eyes.released).toEqual([CAPTURE_FAULT_ENDPOINT]);
        // No picture reached the agent, thus the look does not count and the seen hash stays null.
        expect(gateway.seenOf(threadId)).toBeNull();
    });

    it("keeps the capture when the release fails", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        restoreConnector = setBrowserConnector(() => Promise.resolve(makeFakeBrowser("KEPTPNG")));
        const eyes = makeFakeEyes({ browserUrl: RELEASE_FAULT_ENDPOINT, failRelease: new Error("the browser did not stop") });
        const { logger, warns } = recordingLogger();
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, eyes: eyes.acquire, logger });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        // The capture already passed, thus the failed release changes no outcome of the look.
        expect(result.outcome).toBe("examined");
        expect(readToolResultImage(result)).toEqual({ base64: "KEPTPNG", mediaType: "image/png" });
        expect(eyes.released).toEqual([RELEASE_FAULT_ENDPOINT]);
        expect(gateway.seenOf(threadId)).toBe("rendered-hash");
        // The log is the whole record of a failed release, thus the tool names it there.
        expect(warns).toContain("the eyes lease did not release");
    });

    it("gives the typed capture failure when the acquire fails, and throws nothing", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        const eyes = makeFakeEyes({ browserUrl: "http://examine-unreached.test:9222", failAcquire: new Error("no browser started") });
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, eyes: eyes.acquire });

        const outcome = await tool.execute({}, ctxForThread(threadId));

        expect(outcome.isOk()).toBe(true);
        const result = outcome._unsafeUnwrap();
        expect(result.outcome).toBe("capture-failed");
        if (result.outcome === "capture-failed") {
            expect(result.detail).toContain("no browser started");
        }
        // No lease exists, thus the tool releases nothing and the look does not count.
        expect(eyes.released).toEqual([]);
        expect(gateway.seenOf(threadId)).toBeNull();
    });

    it("gives the typed capture failure when the acquire hangs, and it settles at the deadline", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        const eyes = makeFakeEyes({ browserUrl: "http://examine-acquire-hang.test:9222", hangAcquire: true });
        const tool = createExaminePageTool({
            gateway,
            resolveWorkspaceRoot: () => root,
            chrome: {},
            eyes: eyes.acquire,
            deadlines: { acquireMs: HUNG_DEADLINE_MS },
        });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("capture-failed");
        if (result.outcome === "capture-failed") {
            // The detail names the budget, thus a hung acquire reads apart from a refused acquire.
            expect(result.detail).toBe(`the eyes gave no browser within ${HUNG_DEADLINE_MS} ms`);
        }
        // The acquire gave no lease, thus the tool released nothing and the look does not count.
        expect(eyes.released).toEqual([]);
        expect(gateway.seenOf(threadId)).toBeNull();
    });

    it("keeps the capture when the release hangs", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        restoreConnector = setBrowserConnector(() => Promise.resolve(makeFakeBrowser("HUNGPNG")));
        const eyes = makeFakeEyes({ browserUrl: RELEASE_HANG_ENDPOINT, hangRelease: true });
        const { logger, warns } = recordingLogger();
        const tool = createExaminePageTool({
            gateway,
            resolveWorkspaceRoot: () => root,
            chrome: {},
            eyes: eyes.acquire,
            logger,
            deadlines: { releaseMs: HUNG_DEADLINE_MS },
        });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        // The capture already passed, thus the release that never settles changes no outcome of the look.
        expect(result.outcome).toBe("examined");
        expect(readToolResultImage(result)).toEqual({ base64: "HUNGPNG", mediaType: "image/png" });
        expect(eyes.released).toEqual([RELEASE_HANG_ENDPOINT]);
        expect(gateway.seenOf(threadId)).toBe("rendered-hash");
        // An expired release reads the same as a thrown release, thus the log is its whole record.
        expect(warns).toContain("the eyes lease did not release");
    });
});

describe("the transport precedence", () => {
    it("takes no lease when the composition injects a capture seam", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        const stub: PageCapture = { screenshotBase64: "BASE64PNG", coverage: "full", consoleErrors: [], failedRequests: [] };
        const capture: CapturePage = () => Promise.resolve(stub);
        const eyes = makeFakeEyes({ browserUrl: "http://examine-unused.test:9222" });
        const tool = createExaminePageTool({
            gateway,
            resolveWorkspaceRoot: () => root,
            chrome: { browserUrl: CONFIGURED_ENDPOINT },
            eyes: eyes.acquire,
            capture,
        });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("examined");
        // The capture seam replaces the whole transport, thus the eyes seam answers no call at all.
        expect(eyes.acquired).toEqual([]);
        expect(eyes.released).toEqual([]);
    });

    it("looks through the configured endpoint when the composition binds no capture seam and no eyes seam", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        const connected: string[] = [];
        restoreConnector = setBrowserConnector((browserUrl) => {
            connected.push(browserUrl);
            return Promise.resolve(makeFakeBrowser("STATICPNG"));
        });
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: { browserUrl: CONFIGURED_ENDPOINT } });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("examined");
        expect(readToolResultImage(result)).toEqual({ base64: "STATICPNG", mediaType: "image/png" });
        // The static realization gives the configured endpoint, thus the capture reaches that one.
        expect(connected).toEqual([CONFIGURED_ENDPOINT]);
        expect(gateway.seenOf(threadId)).toBe("rendered-hash");
    });
});

describe("the result detail", () => {
    /** Run the tool's result hook, asserting that the tool declares one. */
    function detailOf(tool: ReturnType<typeof createExaminePageTool>, result: ExaminePageResult): string {
        expect(tool.describeResult).toBeDefined();
        return tool.describeResult!({}, result);
    }

    it("names the look outcome of a capture", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        const stub: PageCapture = { screenshotBase64: "BASE64PNG", coverage: "full", consoleErrors: [], failedRequests: [] };
        const capture: CapturePage = () => Promise.resolve(stub);
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, capture });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(detailOf(tool, result)).toBe("examined");
    });

    it("names the absent page", async () => {
        const root = await makeRoot();
        const gateway = makeFakeGateway();
        gateway.seed("t1", null);
        const capture: CapturePage = () => Promise.reject(new Error("the capture must not run when no page exists"));
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, capture });

        const result = (await tool.execute({}, ctxForThread("t1")))._unsafeUnwrap();

        expect(detailOf(tool, result)).toBe("no-page");
    });

    it("names a failed capture", async () => {
        const root = await makeRoot();
        const threadId = "t1";
        await writePage(root, threadId);
        const gateway = makeFakeGateway();
        gateway.seed(threadId, "rendered-hash");
        const capture: CapturePage = () => Promise.reject(new Error("the browser refused the page"));
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, capture, logger: recordingLogger().logger });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("capture-failed");
        // The cause of the fault stays in the log, thus the line never carries a browser message.
        expect(detailOf(tool, result)).toBe("capture-failed");
    });
});
