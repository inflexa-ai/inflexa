import { ASCII_DIGITS, ASCII_LOWERCASE, ASCII_UPPERCASE, consistsOf, isAsciiDigits, isWhitespace } from "../lib/text.ts";

const LOWER_HEX_DIGITS = `${ASCII_DIGITS}abcdef`;
const HEX_DIGITS = `${LOWER_HEX_DIGITS}ABCDEF`;
const WORD_CHARACTERS = `${ASCII_LOWERCASE}${ASCII_UPPERCASE}${ASCII_DIGITS}_`;

/** True for a non-empty text of lowercase hex digits, and of exactly `length` of them when `length` is given. It replaces `/^[0-9a-f]{length}$/.test(text)`, or `/^[0-9a-f]+$/` with no `length`. */
export function isLowerHex(text: string, length?: number): boolean {
    return (length === undefined || text.length === length) && consistsOf(text, LOWER_HEX_DIGITS);
}

/** True for `#` and six hex digits of either case, and nothing else. It replaces `/^#[0-9a-fA-F]{6}$/.test(text)`. */
export function isHexColor(text: string): boolean {
    return text.length === 7 && text.startsWith("#") && consistsOf(text.slice(1), HEX_DIGITS);
}

/**
 * The maximal runs of ASCII word characters (`A-Z`, `a-z`, `0-9`, `_`) of `text`, in order. A token is what a `\b`
 * boundary of a pattern cuts out, thus `wordTokens(text).includes("S2")` replaces `/\bS2\b/.test(text)`.
 */
export function wordTokens(text: string): string[] {
    const tokens: string[] = [];
    let current = "";
    for (const char of text) {
        if (WORD_CHARACTERS.includes(char)) {
            current += char;
        } else if (current !== "") {
            tokens.push(current);
            current = "";
        }
    }
    if (current !== "") tokens.push(current);
    return tokens;
}

/** True when `suffix` occurs in `text` right after an ASCII digit. It replaces `/\d+suffix/.test(text)` for a literal `suffix`. */
export function hasNumberBefore(text: string, suffix: string): boolean {
    for (let at = text.indexOf(suffix); at !== -1; at = text.indexOf(suffix, at + 1)) {
        if (isAsciiDigits(text.charAt(at - 1))) return true;
    }
    return false;
}

/**
 * True when a `/` of `text` has an ASCII digit on each side. With `spaced`, white space may sit between the digit and
 * the slash. It replaces `/\d+\/\d+/.test(text)`, and `/\d+\s*\/\s*\d+/.test(text)` with `spaced`.
 */
export function hasDigitRatio(text: string, spaced = false): boolean {
    for (let at = text.indexOf("/"); at !== -1; at = text.indexOf("/", at + 1)) {
        let before = at - 1;
        let after = at + 1;
        if (spaced) {
            while (before >= 0 && isWhitespace(text.charAt(before))) before--;
            while (isWhitespace(text.charAt(after))) after++;
        }
        if (isAsciiDigits(text.charAt(before)) && isAsciiDigits(text.charAt(after))) return true;
    }
    return false;
}

/**
 * The number of non-overlapping copies of `needle` in `text`, found left to right. It replaces
 * `(text.match(/needle/g) ?? []).length`. A `RegExp` needle must have no capture group, because `split` puts each
 * group into its result, and it must not match the empty text, because `split` then cuts at every position.
 */
export function countOccurrences(text: string, needle: string | RegExp): number {
    return text.split(needle).length - 1;
}

/** A hole of {@link literalWithHoles}: a pattern source that stands for a class of text, not for itself. */
export type PatternHole = { readonly source: string };

/** One or more ASCII word characters, `\w+`. */
export const WORD: PatternHole = { source: String.raw`\w+` };

/** One or more ASCII word characters or hyphens, `[\w-]+`. */
export const WORD_DASH: PatternHole = { source: String.raw`[\w-]+` };

const REGEXP_SPECIAL_CHARACTERS = ".*+?^${}()|[]\\/";

function escapeLiteral(text: string): string {
    return text
        .split("")
        .map((unit) => (REGEXP_SPECIAL_CHARACTERS.includes(unit) ? `\\${unit}` : unit))
        .join("");
}

/**
 * A pattern for text with holes, written as a tagged template. A literal part and a `string` value match
 * themselves, each special character escaped, and a {@link PatternHole} matches its class of text. A PROV-N
 * statement with a generated id is the typical use: the tag, then `used(inflexa:used-`, then the hole WORD,
 * then `; `, then the qualified name of an entity.
 */
export function literalWithHoles(strings: TemplateStringsArray, ...values: readonly (string | PatternHole)[]): RegExp {
    let source = escapeLiteral(strings[0] ?? "");
    for (const [at, value] of values.entries()) {
        source += (typeof value === "string" ? escapeLiteral(value) : value.source) + escapeLiteral(strings[at + 1] ?? "");
    }
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- The one builder of a pattern from escaped literal parts and holes: the test needs a hole of a character class (`\w+`) in the middle of a statement, and a string method cannot match a class with a backtracking boundary.
    return new RegExp(source);
}
