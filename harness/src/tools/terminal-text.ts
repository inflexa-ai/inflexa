/**
 * The text of a terminal call: a clarification question or a blocker reason.
 *
 * A terminal call whose text is a placeholder ends a run with nothing. A small
 * model emits such a call when it drafts several calls at once and fills the
 * text later, or never. The input schema of the tool names the fault, the call
 * gets an error result, and the loop continues with the real work.
 */

import { z } from "zod";

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the anchored placeholder words and their n/a spellings, at the start of the text; the alternation is the guard's own word list.
const PLACEHOLDER_TEXT = /^\s*(?:placeholder|todo|tbd|skip|n\/?a|none|null|test|x+|\.+|-+)\b/i;
export const MIN_TERMINAL_TEXT = 4;

/** The reason a text cannot end a run, or undefined when it can. */
export function degenerateTerminalText(text: string): string | undefined {
    const trimmed = text.trim();
    if (trimmed.length < MIN_TERMINAL_TEXT)
        return `The text has ${trimmed.length} characters, and a real question or reason has at least ${MIN_TERMINAL_TEXT}.`;
    if (PLACEHOLDER_TEXT.test(trimmed) || holdsStandaloneWord(trimmed, "placeholder")) return "The text is a placeholder.";
    return undefined;
}

/** The text of a terminal call. The schema refuses a placeholder, and the issue says what to do instead. */
export function terminalTextSchema(description: string): z.ZodString {
    return z
        .string()
        .min(1)
        .check(
            z.superRefine((text, ctx) => {
                const degenerate = degenerateTerminalText(text);
                if (degenerate !== undefined) ctx.addIssue({ code: "custom", message: `${degenerate} Give the real text, or continue the work.` });
            }),
        )
        .describe(description);
}

/** Whether `word` occurs in `text` as a standalone word, case-insensitively. */
function holdsStandaloneWord(text: string, word: string): boolean {
    const lower = text.toLowerCase();
    const needle = word.toLowerCase();
    let at = lower.indexOf(needle);
    while (at >= 0) {
        const boundedBefore = at === 0 || !isWordChar(lower.charAt(at - 1));
        const end = at + needle.length;
        const boundedAfter = end >= lower.length || !isWordChar(lower.charAt(end));
        if (boundedBefore && boundedAfter) return true;
        at = lower.indexOf(needle, at + 1);
    }
    return false;
}

function isWordChar(char: string): boolean {
    return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "_";
}
