/**
 * The call detail: one line naming what a tool call is doing.
 *
 * A tool states it through its own `describeCall` hook, colocated with the Zod
 * `inputSchema` the compiler checks it against. Everything else about the
 * detail happens here, once, for every tool: validate, guard, normalize.
 *
 * Two rules make this the only place that matters:
 *
 * 1. **The detail is a diagnostic and must never fail a call.** A hook that
 *    throws, returns a non-string, or returns nothing usable yields no detail
 *    and the tool dispatches unchanged.
 * 2. **Normalization is not delegated to tool authors.** Thirty authors would
 *    each get the line breaks, the control characters, the secret redaction, and
 *    the length cap slightly wrong. Here it is one auditable path.
 */

import type { ToolCallDetail } from "../contracts/chat-events.js";
import { normalizeUnicode, redactSecrets } from "../input-sanitization.js";
import type { Logger } from "../lib/logger.js";
import type { Tool } from "../tools/define-tool.js";

export type { ToolCallDetail };

/**
 * The length cap, in characters. A full workspace path with a line range fits
 * comfortably; a `write_file` content field does not, which is the point — a
 * hook author who returns a payload cannot push it to a host through this
 * channel.
 */
export const DETAIL_MAX_LENGTH = 120;

/**
 * Normalize whatever a hook returned into an emittable detail, or `undefined`.
 *
 * In order: reject anything that is not a usable string, strip control
 * characters, collapse to one line, redact secrets, then cap the length.
 *
 * The control-character strip is the harness's existing `normalizeUnicode`,
 * which is also what the chat route applies to user prose — a detail is
 * rendered by a host, so a terminal escape sequence in it is an injection.
 * Redaction runs before the cap, so a secret cannot survive by being cut in
 * half, and after the strip, so an embedded control byte cannot break a pattern.
 */
export function normalizeDetail(raw: unknown): ToolCallDetail | undefined {
    if (typeof raw !== "string" || raw.length === 0) return undefined;

    // `normalizeUnicode` leaves tab, newline and carriage return in place (they
    // are legitimate whitespace in prose); the collapse below is what turns them
    // into the single line this contract promises.
    const oneLine = normalizeUnicode(raw).replace(/\s+/g, " ").trim();
    if (oneLine.length === 0) return undefined;

    const redacted = redactSecrets(oneLine);
    const capped = redacted.length > DETAIL_MAX_LENGTH ? redacted.slice(0, DETAIL_MAX_LENGTH).trimEnd() : redacted;
    return capped.length === 0 ? undefined : capped;
}

/**
 * Compute a tool call's detail, best-effort.
 *
 * `rawInput` is unvalidated model output: the loop emits `tool-started` before
 * `dispatchTools` parses anything, so the value here has satisfied no schema
 * yet. The hook declares its parameter as `z.infer<Schema>`, so it is called
 * ONLY on a successful `safeParse` — without that, the declared type would be a
 * lie and author-written code would run over arbitrary shapes.
 *
 * A call the loop repairs later (`repairToolInput`) therefore emits no detail.
 * That is accepted: repair is a rare recovery path, and computing the detail a
 * second time from the repaired value costs more than the case is worth.
 */
export function computeDetail(tool: Tool, rawInput: unknown, log: Logger): ToolCallDetail | undefined {
    const describeCall = tool.describeCall;
    if (describeCall === undefined) return undefined;

    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) return undefined;

    try {
        return normalizeDetail(describeCall(parsed.data));
    } catch (err) {
        // `debug`, not `warn`: a broken description is a cosmetic defect in one
        // tool, and the turn it happened in succeeded.
        log.debug("describeCall failed", { tool: tool.id, ...log.errorFields(err) });
        return undefined;
    }
}
