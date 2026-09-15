/**
 * The text of a terminal call: a clarification question or a blocker reason.
 *
 * A terminal call whose text is a placeholder ends a run with nothing. A small
 * model emits such a call when it drafts several calls at once and fills the
 * text later, or never. The guard names the fault, the tool refuses the call,
 * and the loop continues with the real work.
 */

const PLACEHOLDER_TEXT = /^\s*(?:placeholder|todo|tbd|skip|n\/?a|none|null|test|x+|\.+|-+)\b/i;
export const MIN_TERMINAL_TEXT = 4;

/** The reason a text cannot end a run, or undefined when it can. */
export function degenerateTerminalText(text: string): string | undefined {
    const trimmed = text.trim();
    if (trimmed.length < MIN_TERMINAL_TEXT)
        return `The text has ${trimmed.length} characters, and a real question or reason has at least ${MIN_TERMINAL_TEXT}.`;
    if (PLACEHOLDER_TEXT.test(trimmed) || /\bplaceholder\b/i.test(trimmed)) return "The text is a placeholder.";
    return undefined;
}
