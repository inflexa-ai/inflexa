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
 * The bound a hook gives a free-form needle that it marks inside a detail.
 *
 * A needle is model-authored text of no fixed length, thus it is the one part of
 * a detail that can run away. Left to {@link DETAIL_MAX_LENGTH}, a long needle
 * takes the whole line, and the cut lands inside the mark that names it: the
 * closing quote goes, and a second fact behind it goes with no trace. A hook
 * bounds the needle first. Then the mark always closes, and the rest of the
 * detail keeps its room.
 *
 * 32 code points shows the shape of a search — enough to recognize the needle a
 * caller typed, and short enough that a target beside it survives whole.
 */
export const DETAIL_NEEDLE_MAX_LENGTH = 32;

/**
 * Cap `text` at `max` CODE POINTS, not UTF-16 units.
 *
 * A hook calls this to pre-empt the emit-site cap: that cap cuts the TAIL, so a
 * detail with two parts loses the second one when the first runs long. One
 * implementation serves both sites, thus a hook's own bound cuts and marks
 * exactly as {@link normalizeDetail} does.
 *
 * `String.prototype.slice` cuts at a fixed unit index, which can land between the
 * two halves of a surrogate pair and emit a lone surrogate — a terminal paints
 * that as a replacement character, so the cap would corrupt the very tail it is
 * supposed to merely shorten. Iterating the string yields whole code points.
 *
 * Code points, not display columns, is the right unit here: this cap is a safety
 * valve against a runaway hook, so its job is to bound the payload. A column
 * measurement would claim knowledge of the renderer's font metrics that the
 * harness does not have — the host measures columns, because only the host knows
 * how wide its own line is.
 *
 * A cut text carries `…` so that a reader can tell a shortened detail from a
 * complete one. The mark costs one of the `max` code points, thus the cut goes to
 * `max - 1`: a hard bound that overshoots by the width of its own mark is not a
 * hard bound. `trimEnd` runs BEFORE the append, because a cut that lands on a
 * space must give `word…` and not `word …`.
 */
export function capCodePoints(text: string, max: number): string {
    const points = Array.from(text);
    if (points.length <= max) return text;
    const cut = points.slice(0, max - 1).join("");
    return `${cut.trimEnd()}…`;
}

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

    const capped = capCodePoints(redactSecrets(oneLine), DETAIL_MAX_LENGTH);
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
    // The guard tests for a function, not for presence. A packaged tool comes from
    // an open list — an embedder contributes its own through the host-tools seam —
    // so a `describeCall` that is not callable is reachable. Such a tool counts as
    // undescribed, because the alternative is a TypeError on every one of its calls.
    const describeCall = tool.describeCall;
    if (typeof describeCall !== "function") return undefined;

    try {
        // The parse is INSIDE the guard, not before it. `safeParse` returns an
        // error for a rejected value but THROWS for a schema it cannot run
        // synchronously: an async refinement raises "Encountered Promise during
        // synchronous parse", and a refinement whose predicate throws raises
        // whatever it threw. Refinements survive `defineTool` because
        // `z.toJSONSchema` ignores them, so such a schema reaches here intact —
        // and a tool list is open, since an embedder contributes its own through
        // the host-tools seam. Outside the guard that throw would escape the loop
        // and kill the turn. A description must never be able to fail a call.
        const parsed = tool.inputSchema.safeParse(rawInput);
        if (!parsed.success) return undefined;
        return normalizeDetail(describeCall(parsed.data));
    } catch (err) {
        // `debug`, not `warn`: a broken description is a cosmetic defect in one
        // tool, and the turn it happened in succeeded.
        log.debug("describeCall failed", { tool: tool.id, ...log.errorFields(err) });
        return undefined;
    }
}
