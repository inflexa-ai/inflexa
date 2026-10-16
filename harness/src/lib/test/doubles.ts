/**
 * Builders for the seam doubles the tests hand-assemble: each builder returns
 * the seam's own type with no cast, so the test states only the behavior it
 * drives and the compiler checks the rest of the seam shape.
 */
import { Pool } from "pg";
import type { QueryResult } from "pg";
import { Browser, BrowserContext, Page } from "puppeteer-core";
import type { ScreenshotOptions } from "puppeteer-core";
import type { createK8sSandboxOps } from "../../sandbox/k8s-client.js";
import type { createDockerSandboxOps } from "../../sandbox/docker-client.js";
import { z } from "zod";
import type { RunAuthorizer } from "../../execution/run-authorizer.js";
import type { AgentSession, RunSession } from "../../auth/types.js";
import type { RunLauncher } from "../../execution/run-launcher.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { ChatProvider, EmbeddingProvider } from "../../providers/types.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import type { WorkspaceMutator } from "../../tools/workspace/mutator.js";

function unstubbed(where: string): never {
    throw new Error(`${where}: called without a stub`);
}

/** A `ChatProvider` stub: full seam shape, every call fails until the test overrides the member it drives. */
export function stubChatProvider(members: Partial<ChatProvider> = {}): ChatProvider {
    return Object.assign(
        {
            capabilities: { toolCalling: true },
            chat: () => unstubbed("stubChatProvider.chat"),
            chatStream: () => unstubbed("stubChatProvider.chatStream"),
        },
        members,
    );
}

/** An `EmbeddingProvider` stub: the seam shape with a non-indexable width, overridable per member. */
export function stubEmbeddingProvider(members: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
    return Object.assign({ dimensions: 0, embed: () => unstubbed("stubEmbeddingProvider.embed") }, members);
}

/** A `WorkspaceFilesystem` stub: every read fails until the test overrides the member it drives. */
export function stubWorkspaceFilesystem(members: Partial<WorkspaceFilesystem> = {}): WorkspaceFilesystem {
    return Object.assign(
        {
            readFile: () => unstubbed("stubWorkspaceFilesystem.readFile"),
            readBytes: () => unstubbed("stubWorkspaceFilesystem.readBytes"),
            list: () => unstubbed("stubWorkspaceFilesystem.list"),
            stat: () => unstubbed("stubWorkspaceFilesystem.stat"),
        },
        members,
    );
}

/** A `SandboxClient` stub: full seam shape, every operation fails until the test overrides the member it drives. */
export function stubSandboxClient(members: Partial<SandboxClient> = {}): SandboxClient {
    return Object.assign(
        {
            toolchainSource: "image",
            createSandbox: () => unstubbed("stubSandboxClient.createSandbox"),
            exec: () => unstubbed("stubSandboxClient.exec"),
            isAlive: () => unstubbed("stubSandboxClient.isAlive"),
            isAliveById: () => unstubbed("stubSandboxClient.isAliveById"),
            teardown: () => unstubbed("stubSandboxClient.teardown"),
            teardownById: () => unstubbed("stubSandboxClient.teardownById"),
            listManagedSandboxes: () => unstubbed("stubSandboxClient.listManagedSandboxes"),
        },
        members,
    );
}

/** A `RunAuthorizer` stub: every gate call fails until the test overrides the member it drives. */
export function stubRunAuthorizer(members: Partial<RunAuthorizer> = {}): RunAuthorizer {
    return Object.assign(
        {
            authorize: () => unstubbed("stubRunAuthorizer.authorize"),
            revoke: () => unstubbed("stubRunAuthorizer.revoke"),
            revokeByJti: () => unstubbed("stubRunAuthorizer.revokeByJti"),
        },
        members,
    );
}

/** A `RunLauncher` stub: the launch call fails until the test overrides it. */
export function stubRunLauncher(members: Partial<RunLauncher> = {}): RunLauncher {
    return Object.assign({ launch: () => unstubbed("stubRunLauncher.launch") }, members);
}

/** An `AgentSession` stub: the request-session shape the test fixtures build, overridable per field. */
export function stubAgentSession(members: Partial<AgentSession> = {}): AgentSession {
    return Object.assign(
        {
            identity: { user: "stub-user" },
            scope: { kind: "analysis", analysisId: "stub-analysis" },
            provenance: { agentId: "stub-agent", callPath: ["stub-agent"] },
            auth: makeLocalAuth(),
        },
        members,
    );
}

/** A `WorkspaceMutator` stub: every write fails until the test overrides the member it drives. */
export function stubWorkspaceMutator(members: Partial<WorkspaceMutator> = {}): WorkspaceMutator {
    return Object.assign(
        {
            writeFile: () => unstubbed("stubWorkspaceMutator.writeFile"),
            recordWrite: () => unstubbed("stubWorkspaceMutator.recordWrite"),
        },
        members,
    );
}

/** The sandbox backend ops the factory functions compose, carried as types so tests can stub them. */
export type K8sSandboxOps = ReturnType<typeof createK8sSandboxOps>;
export type DockerSandboxOps = ReturnType<typeof createDockerSandboxOps>;

/** A k8s backend-ops stub: every operation fails until the test overrides the member it drives. */
export function stubK8sSandboxOps(members: Partial<K8sSandboxOps> = {}): K8sSandboxOps {
    return Object.assign(
        {
            createSandbox: () => unstubbed("stubK8sSandboxOps.createSandbox"),
            teardown: () => unstubbed("stubK8sSandboxOps.teardown"),
            teardownById: () => unstubbed("stubK8sSandboxOps.teardownById"),
            isAlive: () => unstubbed("stubK8sSandboxOps.isAlive"),
            isAliveById: () => unstubbed("stubK8sSandboxOps.isAliveById"),
            listManagedSandboxes: () => unstubbed("stubK8sSandboxOps.listManagedSandboxes"),
        },
        members,
    );
}

/** A docker backend-ops stub: every operation fails until the test overrides the member it drives. */
export function stubDockerSandboxOps(members: Partial<DockerSandboxOps> = {}): DockerSandboxOps {
    return Object.assign(
        {
            createSandbox: () => unstubbed("stubDockerSandboxOps.createSandbox"),
            teardown: () => unstubbed("stubDockerSandboxOps.teardown"),
            teardownById: () => unstubbed("stubDockerSandboxOps.teardownById"),
            isAlive: () => unstubbed("stubDockerSandboxOps.isAlive"),
            isAliveById: () => unstubbed("stubDockerSandboxOps.isAliveById"),
            listManagedSandboxes: () => unstubbed("stubDockerSandboxOps.listManagedSandboxes"),
        },
        members,
    );
}

/** A `RunSession` stub: the durable bundle with its required run frame, overridable per field. */
export function stubRunSession(members: Partial<RunSession> = {}): RunSession {
    return Object.assign(
        {
            identity: { user: "stub-user" },
            scope: { kind: "analysis", analysisId: "stub-analysis" },
            provenance: { agentId: "stub-agent", callPath: ["stub-agent"] },
            runFrame: { runId: "stub-run" },
            auth: makeLocalAuth(),
        },
        members,
    );
}

/** The query argument the harness passes a pool: the SQL text and its parameters. */
export type PoolQueryArg = { text: string; values?: unknown[] };

export const poolQuerySchema = z.object({ text: z.string(), values: z.array(z.unknown()).optional() }).loose();

/** The slice of a query result the harness reads: the row payload and the affected count. */
export type PoolResult = { rows?: unknown[]; rowCount?: number | null };

function unstubbedQuery(): PoolResult {
    throw new Error("poolDouble: query was called without a stub");
}

/**
 * A `Pool` double: a real `Pool` instance (never connected — the constructor
 * only reads config) whose `query` the handler answers. The handler receives
 * the query as `{ text, values }` and may return a bare result or a promise of
 * one; the other pool members come from `members`.
 */
export function poolDouble(
    handler: (query: PoolQueryArg, values: unknown[] | undefined) => PoolResult | Promise<PoolResult> = unstubbedQuery,
    members: Partial<Pool> = {},
): Pool {
    class FakePool extends Pool {
        override async query(...args: unknown[]): Promise<QueryResult> {
            const arg = args[0];
            // The positional form carries its parameters as the second argument; the config form carries them inside the config.
            const query = typeof arg === "string" ? { text: arg, values: Array.isArray(args[1]) ? args[1] : undefined } : poolQuerySchema.parse(arg);
            const answered = await handler(query, query.values);
            return { command: "SELECT", rowCount: answered.rowCount ?? 0, oid: 0, fields: [], rows: answered.rows ?? [] };
        }
    }
    return Object.assign(new FakePool(), members);
}

/**
 * A `Browser` double backed by real `Browser`, `BrowserContext`, and `Page`
 * subclass instances.
 *
 * The puppeteer classes carry an `EventEmitter` base that holds a `#private`
 * field, so no object literal types as one and a subclass instance is the only
 * cast-free double. Every abstract member fails loudly until the member the
 * test drives overrides it. The members the page capture drives answer
 * instead: `setViewport`, `emulateMediaFeatures`, and `goto` stand for a page
 * that loaded nothing, `evaluate` and `waitForSelector` reject (the capture
 * ends both waits on their own `.catch`, so a rejection is the outcome it
 * already treats as "the page never signaled"), and `screenshot` returns the
 * configured bytes in the base64 form the capture reads.
 */
export function stubBrowser(screenshot: string, browserMembers: Partial<Browser> = {}): Browser {
    class StubPage extends Page {
        readonly #shot: string;
        constructor(shot: string) {
            super();
            this.#shot = shot;
        }
        override setViewport(): Promise<void> {
            return Promise.resolve();
        }
        override emulateMediaFeatures(): Promise<void> {
            return Promise.resolve();
        }
        override goto(): Promise<null> {
            return Promise.resolve(null);
        }
        override evaluate(): Promise<never> {
            return Promise.reject(new Error("StubPage.evaluate: no page runtime backs the stub"));
        }
        override waitForSelector(): Promise<never> {
            return Promise.reject(new Error("StubPage.waitForSelector: no page runtime backs the stub"));
        }
        override screenshot(options?: Readonly<ScreenshotOptions> & { encoding: "base64" }): Promise<string>;
        override screenshot(options?: Readonly<ScreenshotOptions>): Promise<Uint8Array>;
        override screenshot(options?: Readonly<ScreenshotOptions>): Promise<string | Uint8Array> {
            if (options?.encoding !== "base64") return Promise.reject(new Error("StubPage.screenshot: the bytes form is not stubbed"));
            return Promise.resolve(this.#shot);
        }
        override async close(): Promise<void> {}

        override isServiceWorkerBypassed(): boolean {
            return unstubbed("StubPage.isServiceWorkerBypassed");
        }
        override isDragInterceptionEnabled(): boolean {
            return unstubbed("StubPage.isDragInterceptionEnabled");
        }
        override isJavaScriptEnabled(): boolean {
            return unstubbed("StubPage.isJavaScriptEnabled");
        }
        override waitForFileChooser(): Promise<never> {
            return unstubbed("StubPage.waitForFileChooser");
        }
        override setGeolocation(): Promise<void> {
            return unstubbed("StubPage.setGeolocation");
        }
        override target(): never {
            return unstubbed("StubPage.target");
        }
        override browser(): never {
            return unstubbed("StubPage.browser");
        }
        override browserContext(): never {
            return unstubbed("StubPage.browserContext");
        }
        override mainFrame(): never {
            return unstubbed("StubPage.mainFrame");
        }
        override createCDPSession(): Promise<never> {
            return unstubbed("StubPage.createCDPSession");
        }
        override get keyboard(): never {
            return unstubbed("StubPage.keyboard");
        }
        override get touchscreen(): never {
            return unstubbed("StubPage.touchscreen");
        }
        override get coverage(): never {
            return unstubbed("StubPage.coverage");
        }
        override get tracing(): never {
            return unstubbed("StubPage.tracing");
        }
        override get mouse(): never {
            return unstubbed("StubPage.mouse");
        }
        override frames(): never[] {
            return unstubbed("StubPage.frames");
        }
        override workers(): never[] {
            return unstubbed("StubPage.workers");
        }
        override setRequestInterception(): Promise<void> {
            return unstubbed("StubPage.setRequestInterception");
        }
        override setBypassServiceWorker(): Promise<void> {
            return unstubbed("StubPage.setBypassServiceWorker");
        }
        override setDragInterception(): Promise<void> {
            return unstubbed("StubPage.setDragInterception");
        }
        override setOfflineMode(): Promise<void> {
            return unstubbed("StubPage.setOfflineMode");
        }
        override emulateNetworkConditions(): Promise<void> {
            return unstubbed("StubPage.emulateNetworkConditions");
        }
        override setDefaultNavigationTimeout(): void {
            unstubbed("StubPage.setDefaultNavigationTimeout");
        }
        override setDefaultTimeout(): void {
            unstubbed("StubPage.setDefaultTimeout");
        }
        override getDefaultTimeout(): number {
            return unstubbed("StubPage.getDefaultTimeout");
        }
        override getDefaultNavigationTimeout(): number {
            return unstubbed("StubPage.getDefaultNavigationTimeout");
        }
        override queryObjects(): Promise<never> {
            return unstubbed("StubPage.queryObjects");
        }
        override cookies(): Promise<never[]> {
            return unstubbed("StubPage.cookies");
        }
        override deleteCookie(): Promise<void> {
            return unstubbed("StubPage.deleteCookie");
        }
        override setCookie(): Promise<void> {
            return unstubbed("StubPage.setCookie");
        }
        override exposeFunction(): Promise<void> {
            return unstubbed("StubPage.exposeFunction");
        }
        override removeExposedFunction(): Promise<void> {
            return unstubbed("StubPage.removeExposedFunction");
        }
        override authenticate(): Promise<void> {
            return unstubbed("StubPage.authenticate");
        }
        override setExtraHTTPHeaders(): Promise<void> {
            return unstubbed("StubPage.setExtraHTTPHeaders");
        }
        override setUserAgent(): Promise<void> {
            return unstubbed("StubPage.setUserAgent");
        }
        override metrics(): Promise<never> {
            return unstubbed("StubPage.metrics");
        }
        override reload(): Promise<null> {
            return unstubbed("StubPage.reload");
        }
        override goBack(): Promise<null> {
            return unstubbed("StubPage.goBack");
        }
        override goForward(): Promise<null> {
            return unstubbed("StubPage.goForward");
        }
        override bringToFront(): Promise<void> {
            return unstubbed("StubPage.bringToFront");
        }
        override setJavaScriptEnabled(): Promise<void> {
            return unstubbed("StubPage.setJavaScriptEnabled");
        }
        override setBypassCSP(): Promise<void> {
            return unstubbed("StubPage.setBypassCSP");
        }
        override emulateMediaType(): Promise<void> {
            return unstubbed("StubPage.emulateMediaType");
        }
        override emulateCPUThrottling(): Promise<void> {
            return unstubbed("StubPage.emulateCPUThrottling");
        }
        override emulateTimezone(): Promise<void> {
            return unstubbed("StubPage.emulateTimezone");
        }
        override emulateIdleState(): Promise<void> {
            return unstubbed("StubPage.emulateIdleState");
        }
        override emulateVisionDeficiency(): Promise<void> {
            return unstubbed("StubPage.emulateVisionDeficiency");
        }
        override viewport(): null {
            return unstubbed("StubPage.viewport");
        }
        override evaluateOnNewDocument(): Promise<never> {
            return unstubbed("StubPage.evaluateOnNewDocument");
        }
        override removeScriptToEvaluateOnNewDocument(): Promise<void> {
            return unstubbed("StubPage.removeScriptToEvaluateOnNewDocument");
        }
        override setCacheEnabled(): Promise<void> {
            return unstubbed("StubPage.setCacheEnabled");
        }
        override createPDFStream(): Promise<never> {
            return unstubbed("StubPage.createPDFStream");
        }
        override pdf(): Promise<Uint8Array> {
            return unstubbed("StubPage.pdf");
        }
        override isClosed(): boolean {
            return unstubbed("StubPage.isClosed");
        }
        override waitForDevicePrompt(): Promise<never> {
            return unstubbed("StubPage.waitForDevicePrompt");
        }
    }
    class StubContext extends BrowserContext {
        readonly #page: StubPage;
        constructor(shot: string) {
            super();
            this.#page = new StubPage(shot);
        }
        override newPage(): Promise<Page> {
            return Promise.resolve(this.#page);
        }
        override async close(): Promise<void> {}
        override targets(): never[] {
            return unstubbed("StubContext.targets");
        }
        override pages(): Promise<Page[]> {
            return unstubbed("StubContext.pages");
        }
        override overridePermissions(): Promise<void> {
            return unstubbed("StubContext.overridePermissions");
        }
        override clearPermissionOverrides(): Promise<void> {
            return unstubbed("StubContext.clearPermissionOverrides");
        }
        override browser(): never {
            return unstubbed("StubContext.browser");
        }
        override cookies(): Promise<never[]> {
            return unstubbed("StubContext.cookies");
        }
        override setCookie(): Promise<void> {
            return unstubbed("StubContext.setCookie");
        }
    }
    class StubBrowser extends Browser {
        readonly #context: StubContext;
        constructor(shot: string) {
            super();
            this.#context = new StubContext(shot);
        }
        override get connected(): boolean {
            return true;
        }
        override get debugInfo() {
            return { pendingProtocolErrors: [] };
        }
        // A browser reached over CDP holds no child process, so `null` is the honest answer.
        override process(): null {
            return null;
        }
        override createBrowserContext(): Promise<BrowserContext> {
            return Promise.resolve(this.#context);
        }
        override browserContexts(): BrowserContext[] {
            return [this.#context];
        }
        override defaultBrowserContext(): BrowserContext {
            return this.#context;
        }
        override wsEndpoint(): string {
            return "ws://stub";
        }
        override newPage(): Promise<Page> {
            return this.#context.newPage();
        }
        override version(): Promise<string> {
            return Promise.resolve("stub");
        }
        override userAgent(): Promise<string> {
            return Promise.resolve("stub");
        }
        override async close(): Promise<void> {}
        override async disconnect(): Promise<void> {}
        override targets(): never[] {
            return unstubbed("StubBrowser.targets");
        }
        override target(): never {
            return unstubbed("StubBrowser.target");
        }
    }
    return Object.assign(new StubBrowser(screenshot), browserMembers);
}

/** The request URL the client built: a string, or a URL object's text. */
export function urlText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof URL) return value.href;
    throw new Error(`expected a request URL, got ${typeof value}`);
}

/** The request body the client built: the string form; anything else has no text to parse. */
export function requestBodyText(value: unknown): string {
    if (typeof value === "string") return value;
    throw new Error(`expected a string request body, got ${value === null ? "null" : typeof value}`);
}

/**
 * A `fetch` double: the handler sees the raw input and init, and the result is
 * a real `typeof fetch`. A synchronous throw in the handler stays synchronous,
 * the way the replaced inline double threw.
 */
export function fetchDouble(handler: (input: unknown, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
    const double = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => Promise.resolve(handler(input, init));
    // `typeof fetch` carries bun's own `preconnect` member beside the call; the double leaves it to the runtime default.
    double.preconnect = fetch.preconnect;
    return double;
}
