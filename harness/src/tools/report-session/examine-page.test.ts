/**
 * The tests of the eyes tool.
 *
 * Each test drives the tool through `execute` with a temp workspace root, an in-memory gateway, and a stub
 * capture that reads no browser. The chrome connection has its own prior art, thus these tests cover the tool
 * orchestration: the no-browser outcome, the no-page outcome, and the seen-hash copy on a capture.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Scope } from "../../auth/types.js";
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
import { createExaminePageTool, type CapturePage, type PageCapture } from "./examine-page.js";

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

describe("the no-browser outcome", () => {
    it("reports the absent browser up front when the composition gives no browser and no capture seam, and stamps nothing", async () => {
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
        const stub: PageCapture = { screenshotBase64: "BASE64PNG", consoleErrors: [], failedRequests: [] };
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
        const stub: PageCapture = { screenshotBase64: "BASE64PNG", consoleErrors: [], failedRequests: [] };
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
        const stub: PageCapture = { screenshotBase64: "BASE64PNG", consoleErrors: ["boom"], failedRequests: [{ url: "assets/x.png", reason: "net" }] };
        const capture: CapturePage = (url) => {
            capturedUrl = url;
            return Promise.resolve(stub);
        };
        const tool = createExaminePageTool({ gateway, resolveWorkspaceRoot: () => root, chrome: {}, capture });

        const result = (await tool.execute({}, ctxForThread(threadId)))._unsafeUnwrap();

        expect(result.outcome).toBe("examined");
        if (result.outcome === "examined") {
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
});
