/**
 * The digest of the faults of one look. A blocked inline font logs its whole base64 body, often many times,
 * thus the raw lists can cost more context than the pictures of the look.
 */

import type { FailedRequest } from "../../lib/page-capture.js";
import { capCodePoints } from "../../loop/tool-detail.js";

/** One distinct console error of a look, and how many times the page logged it. */
export interface ConsoleErrorEntry {
    text: string;
    count: number;
}

/** One distinct failed request of a look, and how many times the page made it. */
export interface FailedRequestEntry {
    url: string;
    reason: string;
    count: number;
}

/** The digest of one look. `omittedFaults` counts the distinct entries that the cap left out, thus a cut is never silent. */
export interface PageFaults {
    consoleErrors: ConsoleErrorEntry[];
    failedRequests: FailedRequestEntry[];
    omittedFaults?: { consoleErrors: number; failedRequests: number };
}

/** The most code points of one fault text, after the placeholders replace the inline data. */
const MAX_FAULT_TEXT = 300;

/** The most distinct entries of one list. */
const MAX_FAULT_ENTRIES = 20;

/** A data URI. A fault text quotes a URI in quotes or parentheses, thus those characters end the data. */
const DATA_URI = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[^,;\s'"()<>]*)*),([^\s'"()<>]*)/gi;

/** A base64 run of 100 characters or more. A content hash in hex is 64 characters, thus a hash stays. */
const BASE64_RUN = /[A-Za-z0-9+/]{100,}={0,2}/g;

/** Shorten one fault text: the inline data becomes placeholders, and the text stops at the cap. */
export function shortenFaultText(text: string): string {
    const inlined = text.replace(DATA_URI, (_uri: string, mediaType: string | undefined, _parameters: string, data: string) => {
        return `[inline ${mediaType ?? "text/plain"} data, ${data.length} chars]`;
    });
    const unrun = inlined.replace(BASE64_RUN, (run) => `[base64 data, ${run.length} chars]`);
    return capCodePoints(unrun, MAX_FAULT_TEXT);
}

/** Collapse each repeat of one list into one entry with a count. A `Map` keeps the first occurrence order. */
function collapse<T>(items: readonly T[], keyOf: (item: T) => string): Array<{ item: T; count: number }> {
    const byKey = new Map<string, { item: T; count: number }>();
    for (const item of items) {
        const key = keyOf(item);
        const held = byKey.get(key);
        if (held === undefined) {
            byKey.set(key, { item, count: 1 });
        } else {
            held.count += 1;
        }
    }
    return [...byKey.values()];
}

/** Digest the raw faults of one capture into the short lists that the agent reads. */
export function digestPageFaults(consoleErrors: readonly string[], failedRequests: readonly FailedRequest[]): PageFaults {
    const errors = collapse(consoleErrors.map(shortenFaultText), (text) => text).map(({ item, count }) => ({ text: item, count }));
    const requests = collapse(
        failedRequests.map((request) => ({ url: shortenFaultText(request.url), reason: shortenFaultText(request.reason) })),
        (request) => `${request.url}\n${request.reason}`,
    ).map(({ item, count }) => ({ ...item, count }));
    const omittedErrors = Math.max(0, errors.length - MAX_FAULT_ENTRIES);
    const omittedRequests = Math.max(0, requests.length - MAX_FAULT_ENTRIES);
    return {
        consoleErrors: errors.slice(0, MAX_FAULT_ENTRIES),
        failedRequests: requests.slice(0, MAX_FAULT_ENTRIES),
        ...(omittedErrors + omittedRequests > 0 ? { omittedFaults: { consoleErrors: omittedErrors, failedRequests: omittedRequests } } : {}),
    };
}
