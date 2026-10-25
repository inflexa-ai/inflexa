/**
 * Text shapes shared across module families: whitespace runs, line
 * boundaries, separator cuts, trailing cutsets, and the all-one-class
 * predicates. Each is built on the string methods, so no pattern exists
 * here.
 */

const WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

function isWhitespace(char: string): boolean {
    return WHITESPACE.includes(char);
}

/** Collapse every run of whitespace to one space and trim both ends. */
export function collapseWhitespace(text: string): string {
    let out = "";
    let inWhitespaceRun = false;
    for (const char of text) {
        if (isWhitespace(char)) {
            inWhitespaceRun = true;
            continue;
        }
        if (inWhitespaceRun && out.length > 0) out += " ";
        inWhitespaceRun = false;
        out += char;
    }
    return out;
}

/** Split on CRLF or LF; a `\r` not followed by `\n` stays in its line. */
export function splitLines(text: string): string[] {
    return text.split("\n").map((line, index, lines) => (index < lines.length - 1 && line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** The text before the first occurrence of any character of `separators`. */
export function firstSegmentOf(text: string | undefined, separators: string): string | undefined {
    if (text === undefined) return undefined;
    let end = text.length;
    for (const separator of separators) {
        const at = text.indexOf(separator);
        if (at >= 0 && at < end) end = at;
    }
    return text.slice(0, end);
}

/** Whether any character of `text` is whitespace. */
export function hasWhitespace(text: string): boolean {
    return [...text].some(isWhitespace);
}

/** Strip every trailing character that appears in `cutset`. */
export function trimTrailingOf(text: string, cutset: string): string {
    let end = text.length;
    while (end > 0 && cutset.includes(text.charAt(end - 1))) end--;
    return text.slice(0, end);
}

function isAsciiDigit(char: string): boolean {
    return char >= "0" && char <= "9";
}

const HEX_DIGITS = "0123456789abcdefABCDEF";

/** Whether every character of `text` is a decimal digit; the empty text is all digits. */
export function isAllDigits(text: string): boolean {
    return [...text].every(isAsciiDigit);
}

/** Whether every character of `text` is a hexadecimal digit; the empty text is all hex. */
export function isAllHex(text: string): boolean {
    return [...text].every((char) => HEX_DIGITS.includes(char));
}

/** Whether `text` spells the dash-separated calendar form `YYYY-MM-DD`; the digit runs stay unchecked against the calendar. */
export function isIsoDate(text: string): boolean {
    return (
        text.length === 10 &&
        text.charAt(4) === "-" &&
        text.charAt(7) === "-" &&
        isAllDigits(text.slice(0, 4)) &&
        isAllDigits(text.slice(5, 7)) &&
        isAllDigits(text.slice(8))
    );
}
