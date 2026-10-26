/**
 * The one `Function` construction of the report-render tests, and its runners.
 *
 * The body is compiled page source — the string that `render.ts`, `page.ts`,
 * or `views/*.tsx` ships — run against fake browser globals. That run is the
 * point of these tests, not an eval of untrusted input.
 */

import { parseUnknownRecord } from "../../lib/unknown-containers.js";

function runPageSource(params: string[], args: unknown[], body: string): unknown {
    // oxlint-disable-next-line typescript/no-implied-eval -- compiled page source run against fake browser globals; the point of the test, not an eval of untrusted input
    return Reflect.apply(new Function(...params, body), undefined, args);
}

/**
 * Run compiled page source against the fake browser globals that the params
 * name and the args give.
 */
export function runPageScript(params: string[], args: unknown[], script: string): void {
    runPageSource(params, args, script);
}

/**
 * Evaluate compiled page source that ends by naming its exports, and give the
 * record back. Each entry pairs the record key with the name that the page
 * source binds. The record is an own-property copy: the page returns plain
 * object literals, so no prototype member is lost.
 */
export function pageExports(params: string[], args: unknown[], source: string, exports: Array<[string, string]>): Record<string, unknown> {
    const tail = exports.map(([key, name]) => `${JSON.stringify(key)}: ${name}`).join(", ");
    const made: unknown = runPageSource(params, args, `${source}\nreturn { ${tail} };`);
    const record = parseUnknownRecord(made);
    if (record === undefined) throw new Error("the page source returned no record");
    return record;
}
