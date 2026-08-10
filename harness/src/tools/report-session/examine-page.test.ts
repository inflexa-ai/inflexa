/**
 * The tests of the eyes tool.
 *
 * Each test drives the tool through `execute` with a temp workspace root, an in-memory gateway, and a stub
 * capture that reads no browser. The chrome connection has its own prior art, thus these tests cover the tool
 * orchestration: the no-page outcome, and the seen-hash copy on a capture.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Scope } from "../../auth/types.js";
import type { ReportSessionState, ReportSessionStateGateway, SessionStateLoad, SessionStatePersist, StampResult } from "../report-authoring/authoring-tools.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
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
        stampSeen(threadId): Promise<StampResult> {
            const row = rows.get(threadId);
            if (row === undefined) {
                return Promise.resolve({ outcome: "absent" });
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

describe("the seen-stamp copy", () => {
    it("captures the page, gives the picture and the faults, and copies the rendered hash onto the seen hash", async () => {
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
            expect(result.screenshotBase64).toBe("BASE64PNG");
            expect(result.consoleErrors).toEqual(["boom"]);
            expect(result.failedRequests).toEqual([{ url: "assets/x.png", reason: "net" }]);
        }
        // The tool navigates to the page file through a file URL.
        expect(capturedUrl).toBeDefined();
        expect(fileURLToPath(capturedUrl!)).toBe(join(root, "report-sessions", threadId, "index.html"));
        // The look copies the rendered hash onto the seen hash, thus the record lets the current draft record.
        expect(gateway.seenOf(threadId)).toBe("rendered-hash");
    });
});
