/**
 * `web_fetch` — the page-reading step of the conversation agent's web research.
 *
 * One URL in, extracted text out: HTML becomes Markdown (Readability over a
 * `linkedom` DOM, then Turndown, with the body text as the fallback), a PDF
 * becomes the text of its first 100 pages through `pdf-parse`, and a text or
 * JSON body passes through. A bad scheme, an internal address, an HTTP error, an
 * oversized body, a redirect chain past the limit, and a body the tool cannot
 * extract are all normal results on the ok channel — never a failure of the
 * turn.
 *
 * The address guard reads the address the connection itself uses, because a
 * separate name resolution before a `fetch` races the resolver (DNS rebinding):
 * a literal host classifies before the request is sent — the connection layer
 * runs no name lookup for a literal — and a name classifies inside the `lookup`
 * hook of `node:http`/`node:https`, over every address of the resolution,
 * because the connect layer falls back to a later address after an earlier one
 * fails. A guarded hop is destroyed before it connects, and the call gives a
 * refusal that names the origin. The tool asks nothing.
 */

import { errorMessageOf } from "../../lib/thrown.js";
import { textOf } from "../../lib/unknown-text.js";
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { BrotliDecompress, Gunzip, Inflate } from "node:zlib";
import { ok, type Result } from "neverthrow";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { z } from "zod";
import { presentLast } from "../../lib/present.js";
import { hasWhitespace } from "../../lib/text.js";

import { keptTextOf, pairSafeIndex, TOOL_RESULT_CAP, toolOutputRef, type ToolOutputStore } from "../../loop/tool-output.js";
import { defineTool, type Tool, type ToolContext, type ToolError } from "../define-tool.js";
import { HARNESS_USER_AGENT } from "../lib/api-utils.js";
import { isGuardedAddress } from "./guarded-address.js";

const MAX_REDIRECTS = 5;
const HOP_TIMEOUT_MS = 120_000;
const HTML_TEXT_LIMIT_BYTES = 5 * 1024 * 1024;
const PDF_LIMIT_BYTES = 20 * 1024 * 1024;
const PDF_PAGE_CAP = 100;
const MAX_TEXT_CHARS = 30_000;
// The loop JSON-escapes the text of a result, and an escape can make a text two to six times longer.
const RESULT_BUDGET = TOOL_RESULT_CAP - 512;

/** The response head and body stream of one hop, narrowed to what the tool reads. */
export type WebFetchHopResponse = {
    readonly statusCode?: number;
    readonly headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: Buffer) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    destroy(error?: Error): void;
    /** A real response holds these; the decode path pauses the encoded side while the decoder drains. */
    pause?(): void;
    resume?(): void;
};

/** One hop request, narrowed to what the tool drives. */
export type WebFetchHopRequestHandle = {
    on(event: "response", listener: (response: WebFetchHopResponse) => void): void;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "timeout", listener: () => void): void;
    end(): void;
    destroy(error?: Error): void;
};

export type WebFetchHopRequestOptions = {
    readonly headers: Record<string, string>;
    readonly lookup?: LookupFunction;
    readonly timeoutMs: number;
};

/** One HTTP hop. The default is the real `node:http`/`node:https` request; a test can substitute a recorded hop. */
export type WebFetchHopRequest = (url: URL, options: WebFetchHopRequestOptions) => WebFetchHopRequestHandle;

/** A name resolution that answers every address at once, the `all: true` shape of `dns.lookup`. */
export type WebFetchLookup = (
    hostname: string,
    options: LookupAllOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const defaultHopRequest: WebFetchHopRequest = (url, options) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    // A pooled socket skips the lookup hook, and the hook is the only guard for a name host, thus every hop opens its own connection.
    return send(url, { agent: false, headers: options.headers, lookup: options.lookup, timeout: options.timeoutMs });
};

export type WebFetchKept = {
    readonly ref: string;
    readonly keptLength: number;
};

export type WebFetchPdfCut = {
    readonly totalPages: number;
    readonly pagesRead: number;
};

export type WebFetchOk = {
    readonly status: "ok";
    readonly finalUrl: string;
    readonly contentType: string;
    readonly text: string;
    readonly totalLength: number;
    readonly cut: boolean;
    readonly pdfCut?: WebFetchPdfCut;
    readonly kept?: WebFetchKept;
    readonly remainderNotKept?: boolean;
};

export type WebFetchOutput =
    | WebFetchOk
    | { readonly status: "invalid_url"; readonly text: string }
    | { readonly status: "unsupported_scheme"; readonly scheme: string; readonly text: string }
    | { readonly status: "refused"; readonly text: string }
    | { readonly status: "http_error"; readonly httpStatus: number; readonly text: string }
    | { readonly status: "redirect_limit"; readonly text: string }
    | { readonly status: "body_too_large"; readonly limitBytes: number; readonly contentType: string; readonly text: string }
    | { readonly status: "unextractable"; readonly contentType: string; readonly text: string; readonly detail?: string }
    | { readonly status: "request_failed"; readonly text: string; readonly detail?: string };

export type WebFetchToolDeps = {
    readonly toolOutputStore?: ToolOutputStore;
    /** Substitutes the name resolution, so a test answers a controlled address set. The default is `dns.lookup`. */
    readonly lookup?: WebFetchLookup;
    /** Substitutes one HTTP hop, so a test serves recorded bodies offline. The default is the real node hop. */
    readonly hopRequest?: WebFetchHopRequest;
};

const markdownConverter = new TurndownService();

/** The redirect statuses the tool follows itself; node follows none. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class GuardedHopSignal extends Error {
    constructor() {
        super("the resolution holds a guarded address");
        this.name = "GuardedHopSignal";
    }
}

function abortError(): Error {
    const error = new Error("The turn was aborted before web_fetch finished.");
    error.name = "AbortError";
    return error;
}

function hopTimeoutError(url: URL): Error {
    return new Error(`web_fetch timed out after ${HOP_TIMEOUT_MS}ms on ${url.toString()}.`);
}

function isAbort(error: Error, ctx: ToolContext): boolean {
    return error.name === "AbortError" || ctx.signal.aborted;
}

/** The origin of a URL: scheme, host, and the port the connection uses, with the default filled in. */
function originOf(url: URL): string {
    const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
    return `${url.protocol}//${url.hostname}:${port}`;
}

function firstHeaderOf(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const value = headers[name];
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value[0] : value;
}

function mimeTypeOf(headers: Record<string, string | string[] | undefined>): string {
    return (firstHeaderOf(headers, "content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function bodyLimitOf(contentType: string): number {
    return contentType === "application/pdf" ? PDF_LIMIT_BYTES : HTML_TEXT_LIMIT_BYTES;
}

function hopHeaders(): Record<string, string> {
    return {
        "user-agent": HARNESS_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/pdf,text/*,application/json;q=0.9,*/*;q=0.5",
        "Accept-Encoding": "identity",
    };
}

function stripAddressBrackets(hostname: string): string {
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Node derives a Basic Authorization header from the user:pass of a URL; a web_fetch hop carries no credentials. */
function withoutCredentials(url: URL): URL {
    const clean = new URL(url.toString());
    clean.username = "";
    clean.password = "";
    return clean;
}

function refusedGuarded(url: URL): WebFetchOutput {
    return {
        status: "refused",
        text:
            `web_fetch did not read ${url.toString()}: the origin ${originOf(url)} has an internal address ` +
            `(loopback, private, link-local, or reserved), and web_fetch reads no internal address.`,
    };
}

type HopOutcome = { kind: "response"; response: WebFetchHopResponse; dispose: () => void } | { kind: "guarded" } | { kind: "failed"; output: WebFetchOutput };

type HopState = {
    readonly lookup: WebFetchLookup;
    readonly hopRequest: WebFetchHopRequest;
    readonly ctx: ToolContext;
};

/**
 * Send one hop. The `lookup` hook classifies every address of each resolution
 * before the connect can use any of it: when a guarded address appears, the hook
 * answers nothing and destroys the request, so no socket opens.
 */
function sendHop(url: URL, state: HopState): Promise<HopOutcome> {
    return new Promise((resolve, reject) => {
        const { ctx } = state;
        let settled = false;
        let liveResponse: WebFetchHopResponse | undefined;
        const finish = (): void => {
            settled = true;
            ctx.signal.removeEventListener("abort", onAbort);
        };
        const settle = (outcome: HopOutcome): void => {
            if (settled) return;
            finish();
            if (outcome.kind !== "response") clearDeadline();
            resolve(outcome);
        };
        const fail = (error: Error): void => {
            if (settled) return;
            finish();
            clearDeadline();
            reject(error);
        };

        const onAbort = (): void => {
            request.destroy(abortError());
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        const request = state.hopRequest(url, {
            headers: hopHeaders(),
            timeoutMs: HOP_TIMEOUT_MS,
            lookup: (hostname, options, callback) => {
                state.lookup(hostname, { ...options, all: true }, (error, addresses) => {
                    if (error) {
                        callback(error, "");
                        return;
                    }
                    if (addresses.some((entry) => isGuardedAddress(entry.address))) {
                        // With no callback the connect never starts, and the destroy
                        // carries the signal out through the error event.
                        request.destroy(new GuardedHopSignal());
                        return;
                    }
                    if (options.all) {
                        callback(null, addresses);
                        return;
                    }
                    // The connect asked for one address (address-family selection off), and node rejects an array there with ERR_INVALID_IP_ADDRESS.
                    const first = addresses[0];
                    if (first === undefined) {
                        const notFound: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
                        notFound.code = "ENOTFOUND";
                        callback(notFound, "");
                        return;
                    }
                    callback(null, first.address, first.family);
                });
            },
        });
        // The socket-idle timeout below does not bound a server that trickles bytes, so a wall clock bounds the whole hop.
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- a guard, not a wait: it destroys the in-flight hop at the wall clock, unrefs so it never holds the process, and the settle disposes it.
        const deadline = setTimeout(() => {
            const error = hopTimeoutError(url);
            liveResponse?.destroy(error);
            request.destroy(error);
        }, HOP_TIMEOUT_MS);
        deadline.unref();
        const clearDeadline = (): void => clearTimeout(deadline);
        request.on("timeout", () => {
            request.destroy(hopTimeoutError(url));
        });
        request.on("error", (error) => {
            if (error instanceof GuardedHopSignal) {
                settle({ kind: "guarded" });
                return;
            }
            // An abort of the turn propagates; every other transport failure is a normal result.
            if (isAbort(error, ctx)) {
                fail(error);
                return;
            }
            settle({ kind: "failed", output: { status: "request_failed", text: `web_fetch could not read ${url.toString()}.`, detail: error.message } });
        });
        request.on("response", (response) => {
            liveResponse = response;
            settle({ kind: "response", response, dispose: clearDeadline });
        });
        request.end();
    });
}

type BodyRead = { kind: "ok"; body: Buffer } | { kind: "tooLarge" } | { kind: "failed"; error: Error };

/**
 * Read the body of one response and count the decoded bytes: the limit stops
 * the read, so a compressed body that decodes past the limit refuses at the
 * decoded boundary and never buffers the bomb.
 */
function readBody(response: WebFetchHopResponse, encoding: string, limitBytes: number, ctx: ToolContext): Promise<BodyRead> {
    return new Promise((resolve) => {
        let settled = false;
        const chunks: Buffer[] = [];
        let total = 0;

        const settle = (result: BodyRead): void => {
            if (settled) return;
            settled = true;
            ctx.signal.removeEventListener("abort", onAbort);
            resolve(result);
        };
        const onDecodedChunk = (chunk: Buffer): void => {
            total += chunk.length;
            if (total > limitBytes) {
                response.destroy();
                decoder?.destroy();
                settle({ kind: "tooLarge" });
                return;
            }
            chunks.push(chunk);
        };
        const onAbort = (): void => {
            response.destroy(abortError());
        };

        const decoder = encoding === "gzip" ? new Gunzip() : encoding === "deflate" ? new Inflate() : encoding === "br" ? new BrotliDecompress() : undefined;

        ctx.signal.addEventListener("abort", onAbort, { once: true });

        if (decoder === undefined) {
            response.on("data", onDecodedChunk);
            response.on("end", () => settle({ kind: "ok", body: Buffer.concat(chunks) }));
            response.on("error", (error) => settle({ kind: "failed", error }));
        } else {
            const stream = decoder;
            stream.on("data", onDecodedChunk);
            stream.on("end", () => settle({ kind: "ok", body: Buffer.concat(chunks) }));
            stream.on("error", (error) => {
                response.destroy();
                settle({ kind: "failed", error });
            });
            response.on("data", (chunk) => {
                // A write that returns false says the decoder buffer is full: pause the encoded side until it drains.
                if (stream.write(chunk)) return;
                response.pause?.();
                stream.once("drain", () => response.resume?.());
            });
            response.on("end", () => {
                stream.end();
            });
            response.on("error", (error) => {
                stream.destroy(error);
            });
        }
    });
}

/** The nesting bound of the HTML extraction guard. Blink caps its parser DOM depth at the same number, so a page a browser flattens must not cost minutes here either. */
const MAX_HTML_NESTING = 512;

/** Elements that never take content: an opening tag opens no nesting level. */
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** Elements whose content is raw text: the scanner skips to their close tag, because markup inside them is not structure. */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "iframe", "noembed"]);

/** A raw-text close repeats the element name in any letter case and ends at whitespace, a slash, or the bracket. */
function isRawTextClose(html: string, at: number, name: string): boolean {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() !== name) return false;
    const next = html.charAt(at + 2 + name.length);
    return next === ">" || next === "/" || hasWhitespace(next);
}

function isTagNameChar(char: string): boolean {
    return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === ":" || char === "-";
}

/** An opening tag in a family closes its open peers before it nests — the implied-end rules that keep a list or a table row of any length flat. */
const IMPLIED_CLOSE_PEERS: Readonly<Record<string, ReadonlySet<string>>> = {
    li: new Set(["li"]),
    dt: new Set(["dt", "dd"]),
    dd: new Set(["dt", "dd"]),
    p: new Set(["p"]),
    option: new Set(["option"]),
    optgroup: new Set(["option", "optgroup"]),
    td: new Set(["td", "th"]),
    th: new Set(["td", "th"]),
    tr: new Set(["tr", "td", "th"]),
    thead: new Set(["thead", "tbody", "tfoot", "tr", "td", "th"]),
    tbody: new Set(["thead", "tbody", "tfoot", "tr", "td", "th"]),
    tfoot: new Set(["thead", "tbody", "tfoot", "tr", "td", "th"]),
};

/**
 * Estimate the deepest element nesting of an HTML document in one linear scan, without building a DOM.
 * Deep nesting is the input shape that makes the linkedom/Readability pair burn CPU for minutes on a
 * body under the byte limit, and the extraction is synchronous, so no deadline can interrupt it — the
 * bound must gate the parse, not watch it. The estimate never parses: void elements and self-closing
 * tags open no level, raw-text elements skip to their close, quoted attribute values hide their `<`,
 * and an implied-close family pops its open peers, so a list or a table of any length stays flat and a
 * stray close tag pops to its nearest matching open.
 */
export function htmlNestingDepth(html: string): number {
    let max = 0;
    const stack: string[] = [];
    const tagName = (start: number, end: number): string => {
        const text = html.slice(start, end);
        const first = text.charAt(0);
        const isLetter = (first >= "a" && first <= "z") || (first >= "A" && first <= "Z");
        if (!isLetter) return "";
        let at = 1;
        while (at < text.length && isTagNameChar(text.charAt(at))) at++;
        return text.slice(0, at).toLowerCase();
    };
    let i = 0;
    while (i < html.length) {
        if (html[i] !== "<") {
            i++;
            continue;
        }
        if (html.startsWith("<!--", i)) {
            const end = html.indexOf("-->", i + 4);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
            const end = html.indexOf(">", i);
            i = end === -1 ? html.length : end + 1;
            continue;
        }
        if (html.startsWith("</", i)) {
            const end = html.indexOf(">", i);
            const name = end === -1 ? "" : tagName(i + 2, end);
            for (let k = stack.length - 1; k >= 0; k--) {
                if (stack[k] === name) {
                    stack.length = k;
                    break;
                }
            }
            i = end === -1 ? html.length : end + 1;
            continue;
        }
        let j = i + 1;
        let quote = "";
        while (j < html.length) {
            const c = html[j];
            if (quote !== "") {
                if (c === quote) quote = "";
            } else if (c === '"' || c === "'") {
                quote = c;
            } else if (c === ">") {
                break;
            }
            j++;
        }
        if (j >= html.length) break;
        const name = tagName(i + 1, j);
        const selfClosed = html[j - 1] === "/";
        i = j + 1;
        if (name === "") continue;
        if (RAW_TEXT_TAGS.has(name)) {
            let close = html.indexOf("</", i);
            while (close !== -1 && !isRawTextClose(html, close, name)) close = html.indexOf("</", close + 1);
            i = close === -1 ? html.length : close + 2 + name.length;
            continue;
        }
        if (selfClosed || VOID_TAGS.has(name)) continue;
        const peers = IMPLIED_CLOSE_PEERS[name];
        if (peers !== undefined) {
            while (stack.length > 0 && peers.has(presentLast(stack, "the top of the tag stack"))) stack.pop();
        }
        stack.push(name);
        if (stack.length > max) {
            max = stack.length;
            if (max > MAX_HTML_NESTING) return max;
        }
    }
    return max;
}

function htmlToMarkdown(body: Buffer): string {
    const dom = parseHTML(body.toString("utf8"));
    const article = new Readability(dom.document).parse();
    if (article?.content) return markdownConverter.turndown(article.content).trim();
    return dom.document.body.textContent.trim();
}

/** Hostile HTML can throw inside the extraction stack; the body text, then the status union, catch the throw. A page that nests past the bound never reaches a parser, because the parse itself is the stall. */
function htmlExtractionOf(body: Buffer): Extracted {
    const html = body.toString("utf8");
    if (htmlNestingDepth(html) > MAX_HTML_NESTING) {
        return { kind: "unextractable", detail: `the HTML nests deeper than ${MAX_HTML_NESTING} elements` };
    }
    try {
        return { kind: "text", text: htmlToMarkdown(body) };
    } catch {
        try {
            const dom = parseHTML(html);
            return { kind: "text", text: dom.document.body.textContent.trim() };
        } catch {
            return { kind: "unextractable", detail: "the HTML extraction failed" };
        }
    }
}

type Extracted = { kind: "text"; text: string; pdfCut?: WebFetchPdfCut } | { kind: "unextractable"; detail?: string };

let pdfParseModule: typeof import("pdf-parse") | undefined;

async function extractBody(contentType: string, body: Buffer): Promise<Extracted> {
    if (contentType === "text/html" || contentType === "application/xhtml+xml") {
        return htmlExtractionOf(body);
    }
    if (contentType === "application/pdf") {
        // `pdf-parse` makes `os.availableParallelism()` return `undefined` process-wide under Bun when its module loads,
        // so the public barrel must never import it statically (inflexa-ai/inflexa#701). The first PDF loads it once.
        pdfParseModule ??= await import("pdf-parse");
        const parser = new pdfParseModule.PDFParse({ data: body });
        try {
            const result = await parser.getText({ first: PDF_PAGE_CAP });
            const pdfCut = result.total > result.pages.length ? { totalPages: result.total, pagesRead: result.pages.length } : undefined;
            return { kind: "text", text: result.text.trim(), pdfCut };
        } catch (error) {
            return { kind: "unextractable", detail: `the PDF parser failed: ${errorMessageOf(error) ?? textOf(error)}` };
        } finally {
            await parser.destroy();
        }
    }
    if (contentType.startsWith("text/") || contentType === "application/json" || contentType.endsWith("+json")) {
        return { kind: "text", text: body.toString("utf8") };
    }
    return { kind: "unextractable" };
}

/** Build the ok result for one returned text, so the serialized-cap shrink rebuilds the same fields each round. */
function okResultOf(
    base: Omit<WebFetchOk, "text" | "cut" | "kept" | "remainderNotKept">,
    fullText: string,
    kept: WebFetchKept | undefined,
    shown: string,
): WebFetchOk {
    const result: { -readonly [K in keyof WebFetchOk]: WebFetchOk[K] } = {
        ...base,
        kept,
        text: shown,
        cut: shown.length < fullText.length,
    };
    if (shown.length < fullText.length && kept === undefined) result.remainderNotKept = true;
    return result;
}

async function fetchOneUrl(rawUrl: string, deps: WebFetchToolDeps, ctx: ToolContext): Promise<WebFetchOutput> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { status: "invalid_url", text: `web_fetch cannot read ${rawUrl}: it is not a valid URL.` };
    }

    const state: HopState = {
        lookup: deps.lookup ?? dnsLookup,
        hopRequest: deps.hopRequest ?? defaultHopRequest,
        ctx,
    };

    let redirects = 0;
    for (let current = parsed; ;) {
        if (current.protocol !== "http:" && current.protocol !== "https:") {
            return { status: "unsupported_scheme", scheme: current.protocol, text: `web_fetch reads http and https only, not ${current.protocol}` };
        }
        if (current.username !== "" || current.password !== "") current = withoutCredentials(current);

        const literal = stripAddressBrackets(current.hostname);
        if (isIP(literal) !== 0 && isGuardedAddress(literal)) return refusedGuarded(current);

        const hop = await sendHop(current, state);
        if (hop.kind === "failed") return hop.output;
        if (hop.kind === "guarded") return refusedGuarded(current);

        const response = hop.response;
        try {
            const status = response.statusCode ?? 0;
            const location = firstHeaderOf(response.headers, "location");
            if (REDIRECT_STATUSES.has(status) && location !== undefined) {
                response.destroy();
                if (redirects >= MAX_REDIRECTS) {
                    return {
                        status: "redirect_limit",
                        text: `web_fetch follows at most ${MAX_REDIRECTS} redirects and gave up after ${redirects} on ${rawUrl}.`,
                    };
                }
                redirects += 1;
                try {
                    current = new URL(location, current);
                } catch {
                    return { status: "request_failed", text: `A redirect of ${current.toString()} names a target that is not a valid URL: ${location}` };
                }
                continue;
            }

            if (status < 200 || status >= 300) {
                response.destroy();
                return { status: "http_error", httpStatus: status, text: `The page at ${current.toString()} answered HTTP ${status}.` };
            }

            const contentType = mimeTypeOf(response.headers);
            const limitBytes = bodyLimitOf(contentType);
            const encoding = (firstHeaderOf(response.headers, "content-encoding") ?? "").trim().toLowerCase();
            if (encoding !== "" && encoding !== "identity" && encoding !== "gzip" && encoding !== "deflate" && encoding !== "br") {
                response.destroy();
                return {
                    status: "request_failed",
                    text: `The page at ${current.toString()} sent the content encoding ${encoding}, which web_fetch cannot decode.`,
                };
            }
            // A Content-Length names the encoded bytes, and an encoding can make them longer than the decoded body, so it gates an identity body only.
            const encoded = encoding === "gzip" || encoding === "deflate" || encoding === "br";
            const contentLength = Number.parseInt(firstHeaderOf(response.headers, "content-length") ?? "", 10);
            if (!encoded && Number.isFinite(contentLength) && contentLength > limitBytes) {
                response.destroy();
                return {
                    status: "body_too_large",
                    limitBytes,
                    contentType,
                    text: `The body of ${current.toString()} is ${contentLength} bytes, over the limit of ${limitBytes} bytes for ${contentType === "" ? "this content type" : contentType}.`,
                };
            }

            const body = await readBody(response, encoding, limitBytes, ctx);
            if (body.kind === "tooLarge") {
                return {
                    status: "body_too_large",
                    limitBytes,
                    contentType,
                    text: `The body of ${current.toString()} passed the limit of ${limitBytes} bytes for ${contentType === "" ? "this content type" : contentType} while it was read.`,
                };
            }
            if (body.kind === "failed") {
                if (isAbort(body.error, ctx)) throw body.error;
                return { status: "request_failed", text: `web_fetch could not read the body of ${current.toString()}.`, detail: body.error.message };
            }

            const extracted = await extractBody(contentType, body.body);
            if (extracted.kind === "unextractable") {
                const named = contentType === "" ? "(no content type)" : contentType;
                return {
                    status: "unextractable",
                    contentType,
                    text: `web_fetch cannot extract text from the content type ${named}.`,
                    detail: extracted.detail,
                };
            }

            const fullText = extracted.text.trim();
            let shown = fullText.length > MAX_TEXT_CHARS ? fullText.slice(0, pairSafeIndex(fullText, MAX_TEXT_CHARS, -1)) : fullText;

            const base: Omit<WebFetchOk, "text" | "cut" | "kept" | "remainderNotKept"> = {
                status: "ok",
                finalUrl: current.toString(),
                contentType,
                totalLength: fullText.length,
                pdfCut: extracted.pdfCut,
            };
            let output = okResultOf(base, fullText, undefined, shown);
            while (JSON.stringify(output).length > RESULT_BUDGET && shown.length > 0) {
                shown = shown.slice(0, pairSafeIndex(shown, Math.floor((shown.length * 3) / 4), -1));
                output = okResultOf(base, fullText, undefined, shown);
            }

            const analysisId = ctx.session.scope.analysisId;
            // The shrink loop can cut a text that passed the 30,000-character cut, so the store decision reads the final shown length.
            let kept: WebFetchKept | undefined;
            if (shown.length < fullText.length && deps.toolOutputStore !== undefined) {
                const content = keptTextOf(fullText);
                const ref = toolOutputRef(`${analysisId}:${ctx.invocationId}`);
                const put = await deps.toolOutputStore.put({
                    analysisId,
                    ref,
                    toolName: "web_fetch",
                    toolCallId: ctx.invocationId,
                    threadId: ctx.session.scope.threadId,
                    content,
                    totalLength: fullText.length,
                });
                if (put.isOk()) kept = { ref, keptLength: content.length };
            }
            return okResultOf(base, fullText, kept, shown);
        } finally {
            hop.dispose();
        }
    }
}

const WebFetchInputSchema = z.object({
    url: z.string().min(1).max(2048).describe("The http or https URL of one page to read, for example a page a web_search result named."),
});

export function createWebFetchTool(deps: WebFetchToolDeps = {}): Tool<z.infer<typeof WebFetchInputSchema>, WebFetchOutput> {
    return defineTool({
        id: "web_fetch",
        description:
            "Read one web page from its http or https URL and get its text: an HTML page becomes Markdown, " +
            "a PDF becomes the text of at most its first 100 pages, and a plain-text or JSON body passes through. " +
            "The tool returns at most 30,000 characters; a longer text is cut, and the result carries a reference " +
            "through which `read_tool_output` reads the remainder when the harness kept it.\n" +
            "ABSENCE AND FAILURE ARE NORMAL: the statuses invalid_url (a URL the tool cannot parse), " +
            "unsupported_scheme (a scheme that is not http or https), refused (an internal address: loopback, " +
            "private, link-local, or reserved), http_error, redirect_limit, body_too_large, unextractable, and request_failed each name what " +
            "happened. Report the status and continue, do not retry unchanged.",
        inputSchema: WebFetchInputSchema,
        describeCall: ({ url }) => url,
        execute: async ({ url }, ctx): Promise<Result<WebFetchOutput, ToolError>> => ok(await fetchOneUrl(url, deps, ctx)),
    });
}
