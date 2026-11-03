/**
 * Cuts the trailing run of the characters in `chars` off `text`. It replaces `text.replace(/[chars]+$/, "")`.
 * Each member of `chars` is one UTF-16 unit, for example `"/"` or `"/\\"`.
 */
export function trimTrailing(text: string, chars: string): string {
    let end = text.length;
    while (end > 0 && chars.includes(text.charAt(end - 1))) end--;
    return text.slice(0, end);
}

/** True for a non-empty text whose each character is `0` to `9`. It replaces `/^\d+$/.test(text)`, and it refuses a sign, an exponent, white space, and a non-ASCII digit. */
export function isAsciiDigits(text: string): boolean {
    if (text === "") return false;
    for (const char of text) {
        if (char < "0" || char > "9") return false;
    }
    return true;
}

/** True when `char` is one white space character: one that `String.prototype.trim` removes, which is the set of `\s`. */
export function isWhitespace(char: string): boolean {
    return char !== "" && char.trim() === "";
}

/** True when `text` holds a white space character. It replaces `/\s/.test(text)`. */
export function hasWhitespace(text: string): boolean {
    for (const char of text) {
        if (isWhitespace(char)) return true;
    }
    return false;
}

/**
 * Splits `text` on each run of white space. It replaces `text.split(/\s+/)` and gives the same array:
 * a leading or a trailing run gives an empty first or last item, and the empty text gives `[""]`.
 */
export function splitWhitespace(text: string): string[] {
    const items: string[] = [];
    let current = "";
    let inRun = false;
    for (const char of text) {
        if (isWhitespace(char)) {
            if (!inRun) {
                items.push(current);
                current = "";
                inRun = true;
            }
        } else {
            current += char;
            inRun = false;
        }
    }
    items.push(current);
    return items;
}

/** Replaces each run of white space in `text` with one space. It replaces `text.replace(/\s+/g, " ")`. */
export function collapseWhitespace(text: string): string {
    return splitWhitespace(text).join(" ");
}

/** `text` without `prefix` at its start. It replaces `text.replace(/^prefix/, "")` for a literal prefix, and it cuts one copy only. */
export function withoutPrefix(text: string, prefix: string): string {
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** `text` without `suffix` at its end. It replaces `text.replace(/suffix$/, "")` for a literal suffix, and it cuts one copy only. */
export function withoutSuffix(text: string, suffix: string): string {
    return text.endsWith(suffix) ? text.slice(0, text.length - suffix.length) : text;
}

/**
 * True when the lowercase of `text` holds one of `phrases`. Each phrase is lowercase. It replaces a case-insensitive
 * alternation such as `/no such image|image not known/i.test(text)`. The two forms agree on ASCII text, and they differ
 * on a rare non-ASCII case form such as the Kelvin sign.
 */
export function mentionsAny(text: string, phrases: readonly string[]): boolean {
    const lower = text.toLowerCase();
    return phrases.some((phrase) => lower.includes(phrase));
}

export const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const ASCII_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const ASCII_DIGITS = "0123456789";

/**
 * True for a non-empty `text` whose each character is in `rest` and whose first character is in `first`. It replaces
 * `/^[first][rest]*$/`. The two alphabets are strings of single characters, for example {@link ASCII_LOWERCASE}.
 */
export function consistsOf(text: string, rest: string, first: string = rest): boolean {
    if (text === "") return false;
    let isFirst = true;
    for (const char of text) {
        if (!(isFirst ? first : rest).includes(char)) return false;
        isFirst = false;
    }
    return true;
}

/** True when `char` is one printable ASCII character, from the space to `~`. It replaces `/[\x20-\x7e]/.test(char)` for one character. */
export function isPrintableAscii(char: string): boolean {
    return char.length === 1 && char >= " " && char <= "~";
}
