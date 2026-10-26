/**
 * Tokenisation and the token-class lattice the detected-set pipeline mines over.
 *
 * A name splits on the boundaries that carry structure — the dotted suffix chain, and
 * runs of letters, digits, and separators inside each dot-part — except where a run is
 * one indivisible token. A machine-issued opaque identifier and a delimited date are
 * each one token, because splitting them yields positions whose values never repeat,
 * and a position whose values never repeat fragments the template space into one
 * template per file.
 *
 * The lattice orders classes by specificity: a value set is described by the most
 * specific class every one of its values satisfies.
 */

import { KNOWN_EXTENSIONS } from "./formats.js";
import { isAllDigits, isAllHex } from "../lib/text.js";
import { presentAt, presentFirst } from "../lib/present.js";
import {
    MAX_OPAQUE_ID_MEAN_RUN,
    MAX_OPAQUE_ID_SEPARATOR_FRACTION,
    MAX_SUFFIX_TOKEN_LENGTH,
    MIN_OPAQUE_ID_CASE_FLIPS,
    MIN_OPAQUE_ID_CHAR_CLASSES,
    MIN_OPAQUE_ID_DIGIT_FRACTION,
    MIN_OPAQUE_ID_LENGTH,
    OPAQUE_ID_CASE_FLIP_DIVISOR,
} from "./tuning.js";

export type TokenKind = "alpha" | "digit" | "delim" | "id" | "date";

export type NameToken = {
    readonly kind: TokenKind;
    readonly value: string;
};

export const ID_SYMBOL = "ID";
export const DIGIT_SYMBOL = "#";
export const DATE_SYMBOL = "@";

export function basenameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

export function dirnameOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Split a basename into its stem and the terminal chain of recognised extensions.
 *
 * The stem may itself contain dots: only a trailing run of known extension tokens is
 * the extension, so the categorical tokens of a dotted suffix chain stay minable.
 */
export function splitStem(fileName: string): { stem: string; suffix: string } {
    const parts = fileName.split(".");
    let cut = parts.length;
    while (cut > 1) {
        const candidate = presentAt(parts, cut - 1, "the trailing extension part").toLowerCase();
        if (!KNOWN_EXTENSIONS.has(candidate) || candidate.length > MAX_SUFFIX_TOKEN_LENGTH) break;
        cut--;
    }
    return { stem: parts.slice(0, cut).join("."), suffix: parts.slice(cut).join(".").toLowerCase() };
}

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the fixed 8-4-4-4-12 hex groups are what make an identifier machine-issued rather than written.
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DIGEST_HEX_LENGTHS = new Set([32, 40, 64]);
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- captures year, month, and day out of `2026-08-24` or `2026_08_24` for the calendar range check below.
const DELIMITED_DATE_PATTERN = /^(\d{4})[-_](\d{2})[-_](\d{2})$/;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the same capture for the compact `20260824` form.
const COMPACT_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- finds a date fused inside a longer run; the lookarounds keep digits outside the date in their own runs.
const EMBEDDED_DATE_PATTERN = /(?<![0-9])(?:\d{4}[-_]\d{2}[-_]\d{2}|\d{8})(?![0-9])/g;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- letter and digit runs are the shape whose mean length separates written words from random class-mixed tokens.
const ALPHA_DIGIT_RUN_PATTERN = /[A-Za-z]+|[0-9]+/g;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- splits a run into letter, digit, and `-_=` separator tokens; the three classes are the token lattice below.
const TOKEN_RUN_PATTERN = /[A-Za-z]+|[0-9]+|[-_=]+/g;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- splits a path segment into base64url-charset runs and the runs outside that charset, each whole.
const SEGMENT_RUN_PATTERN = /[A-Za-z0-9\-_=]+|[^A-Za-z0-9\-_=]+/g;
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- an alphanumeric run of three or more characters inside a shared affix is identifier material to mask.
const MASKABLE_RUN_PATTERN = /[A-Za-z0-9]{3,}/g;

function isAsciiUpper(char: string): boolean {
    return char >= "A" && char <= "Z";
}

function isAsciiLower(char: string): boolean {
    return char >= "a" && char <= "z";
}

export function isAsciiLetter(char: string): boolean {
    return isAsciiUpper(char) || isAsciiLower(char);
}

export function isAsciiDigit(char: string): boolean {
    return char >= "0" && char <= "9";
}

function isBase64UrlSymbol(char: string): boolean {
    return char === "-" || char === "_" || char === "=";
}

function isAlphanumeric(char: string): boolean {
    return isAsciiLetter(char) || isAsciiDigit(char);
}

function hasAsciiUpper(value: string): boolean {
    return Array.from(value).some(isAsciiUpper);
}

function hasAsciiLower(value: string): boolean {
    return Array.from(value).some(isAsciiLower);
}

function hasAsciiLetter(value: string): boolean {
    return Array.from(value).some(isAsciiLetter);
}

function hasAsciiDigit(value: string): boolean {
    return Array.from(value).some(isAsciiDigit);
}

function hasAlphanumeric(value: string): boolean {
    return Array.from(value).some(isAlphanumeric);
}

function isBase64UrlRun(value: string): boolean {
    return value.length > 0 && Array.from(value).every((char) => isAlphanumeric(char) || isBase64UrlSymbol(char));
}

function isHexRun(value: string): boolean {
    return value.length > 0 && isAllHex(value);
}

function charClassCount(value: string): number {
    let classes = 0;
    if (hasAsciiUpper(value)) classes++;
    if (hasAsciiLower(value)) classes++;
    if (hasAsciiDigit(value)) classes++;
    if (Array.from(value).some(isBase64UrlSymbol)) classes++;
    return classes;
}

function meanRunLength(value: string): number {
    const runs = value.match(ALPHA_DIGIT_RUN_PATTERN) ?? [];
    if (runs.length === 0) return 0;
    return runs.reduce((total, run) => total + run.length, 0) / runs.length;
}

function caseTransitions(value: string): number {
    const chars = value.split("");
    let flips = 0;
    for (let i = 1; i < chars.length; i++) {
        const before = presentAt(chars, i - 1, "case-run characters");
        const after = presentAt(chars, i, "case-run characters");
        if (!isAsciiLetter(before) || !isAsciiLetter(after)) continue;
        if ((before === before.toUpperCase()) !== (after === after.toUpperCase())) flips++;
    }
    return flips;
}

function charFraction(value: string, matches: (char: string) => boolean): number {
    let count = 0;
    for (const char of value) if (matches(char)) count++;
    return count / value.length;
}

/**
 * A machine-issued identifier: a UUID, a fixed-length hex digest, or a long
 * class-mixed base64url token that is structurally random.
 *
 * Randomness shows either as case flipping inside letter runs or as digit
 * fragmentation, and either signal alone suffices — a letter-heavy random token has
 * few digit runs, and a digit-heavy one has few letters to flip. Separator density
 * vetoes the second signal only: snake_case is how a person writes a name, and a
 * person's name is not an identifier however many digits it carries.
 */
export function isOpaqueId(value: string): boolean {
    if (UUID_PATTERN.test(value)) return true;
    if (isHexRun(value) && DIGEST_HEX_LENGTHS.has(value.length)) return true;
    if (value.length < MIN_OPAQUE_ID_LENGTH) return false;
    if (!isBase64UrlRun(value)) return false;
    if (charClassCount(value) < MIN_OPAQUE_ID_CHAR_CLASSES) return false;

    const flipBudget = Math.max(MIN_OPAQUE_ID_CASE_FLIPS, Math.floor(value.length / OPAQUE_ID_CASE_FLIP_DIVISOR));
    if (caseTransitions(value) >= flipBudget) return true;

    if (charFraction(value, isBase64UrlSymbol) > MAX_OPAQUE_ID_SEPARATOR_FRACTION) return false;
    return meanRunLength(value) <= MAX_OPAQUE_ID_MEAN_RUN && charFraction(value, isAsciiDigit) >= MIN_OPAQUE_ID_DIGIT_FRACTION;
}

/** A calendar date written compactly or with a single separator: `20260824`, `2026-08-24`. */
export function isDateToken(value: string): boolean {
    const parts = DELIMITED_DATE_PATTERN.exec(value) ?? COMPACT_DATE_PATTERN.exec(value);
    if (!parts) return false;
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    return year >= 1900 && year <= 2999 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function pushRuns(text: string, into: NameToken[]): void {
    for (const run of text.matchAll(TOKEN_RUN_PATTERN)) {
        const value = run[0];
        const head = value.charAt(0);
        const kind: TokenKind = isAsciiDigit(head) ? "digit" : isAsciiLetter(head) ? "alpha" : "delim";
        into.push({ kind, value });
    }
}

/**
 * Tokenise one path segment — a directory name, or one dot-part of a stem.
 *
 * A maximal base64url-charset run is tested whole before it is split, which is what
 * lets a long identifier collapse to one position where masking digit runs cannot. A
 * date embedded in a longer run is lifted out whole for the same reason: split into
 * year, month, and day it becomes three positions that vary together, and the template
 * space grows by the product rather than by one.
 */
export function tokenizeSegment(segment: string): NameToken[] {
    const tokens: NameToken[] = [];
    for (const match of segment.matchAll(SEGMENT_RUN_PATTERN)) {
        const value = match[0];
        if (!hasAlphanumeric(value)) {
            tokens.push({ kind: "delim", value });
            continue;
        }
        if (isDateToken(value)) {
            tokens.push({ kind: "date", value });
            continue;
        }
        if (isOpaqueId(value)) {
            tokens.push({ kind: "id", value });
            continue;
        }
        let cursor = 0;
        for (const embedded of value.matchAll(EMBEDDED_DATE_PATTERN)) {
            if (!isDateToken(embedded[0])) continue;
            pushRuns(value.slice(cursor, embedded.index), tokens);
            tokens.push({ kind: "date", value: embedded[0] });
            cursor = embedded.index + embedded[0].length;
        }
        pushRuns(value.slice(cursor), tokens);
    }
    return tokens;
}

/** Tokenise a full basename. Dot-parts of the stem are joined by explicit delimiter tokens. */
export function tokenizeName(fileName: string): { tokens: NameToken[]; suffix: string } {
    const { stem, suffix } = splitStem(fileName);
    const tokens: NameToken[] = [];
    const parts = stem.split(".");
    for (let i = 0; i < parts.length; i++) {
        if (i > 0) tokens.push({ kind: "delim", value: "." });
        tokens.push(...tokenizeSegment(presentAt(parts, i, "stem dot-parts")));
    }
    return { tokens, suffix };
}

/** The masked form of a token run: variable material becomes its class symbol. */
export function skeletonOf(tokens: readonly NameToken[]): string {
    let out = "";
    for (const token of tokens) {
        if (token.kind === "id") out += ID_SYMBOL;
        else if (token.kind === "digit") out += DIGIT_SYMBOL;
        else if (token.kind === "date") out += DATE_SYMBOL;
        else out += token.value;
    }
    return out;
}

export function maskSegment(segment: string): string {
    return skeletonOf(tokenizeSegment(segment));
}

export type SlotTokenClass = "constant" | "date" | "digits-fixed" | "digits" | "hex" | "opaque-id" | "word" | "pattern" | "any";

export type ValueClass = {
    readonly tokenClass: SlotTokenClass;
    /** Digit width, when every value is a fixed-width number. */
    readonly width?: number;
    readonly minLength?: number;
    readonly maxLength?: number;
    /** The shared masked form, when the class is `pattern`. */
    readonly skeleton?: string;
};

/** Place a set of observed values on the lattice, most specific class first. */
export function classifyValues(values: readonly string[]): ValueClass {
    if (values.length === 0) return { tokenClass: "any" };
    if (values.length === 1) {
        const only = presentFirst(values, "the single value");
        if (isDateToken(only)) return { tokenClass: "date" };
        if (isOpaqueId(only)) return { tokenClass: "opaque-id", minLength: only.length, maxLength: only.length };
        return { tokenClass: "constant" };
    }
    if (values.every((value) => isDateToken(value))) return { tokenClass: "date" };
    if (values.every((value) => value.length > 0 && isAllDigits(value))) {
        const width = presentFirst(values, "digit values").length;
        return values.every((value) => value.length === width) ? { tokenClass: "digits-fixed", width } : { tokenClass: "digits" };
    }
    if (values.every((value) => isHexRun(value) && value.length >= 4)) return { tokenClass: "hex" };
    if (values.every((value) => isOpaqueId(value))) {
        const lengths = values.map((value) => value.length);
        return { tokenClass: "opaque-id", minLength: Math.min(...lengths), maxLength: Math.max(...lengths) };
    }
    if (values.every((value) => value.length > 0 && Array.from(value).every(isAsciiLetter))) return { tokenClass: "word" };
    const skeletons = new Set(values.map((value) => maskSegment(value)));
    const [skeleton] = skeletons;
    if (skeleton !== undefined && skeletons.size === 1 && (skeleton.includes(DIGIT_SYMBOL) || skeleton.includes(ID_SYMBOL) || skeleton.includes(DATE_SYMBOL))) {
        return { tokenClass: "pattern", skeleton };
    }
    return { tokenClass: "any" };
}

/**
 * The longest prefix and suffix shared by every value.
 *
 * A greedy identifier run swallows the literal text fused to it; recovering the shared
 * affixes puts that text back in the template where a reader can see it.
 */
export function commonAffixes(values: readonly string[]): { prefix: string; suffix: string } {
    if (values.length < 2) return { prefix: "", suffix: "" };
    const head = presentFirst(values, "affix values");
    let prefix = head;
    for (const value of values) {
        let i = 0;
        while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
        prefix = prefix.slice(0, i);
        if (!prefix) break;
    }
    let suffix = head.slice(prefix.length);
    for (const value of values) {
        const rest = value.slice(prefix.length);
        let i = 0;
        while (i < suffix.length && i < rest.length && suffix[suffix.length - 1 - i] === rest[rest.length - 1 - i]) i++;
        suffix = suffix.slice(suffix.length - i);
        if (!suffix) break;
    }
    return { prefix, suffix };
}

/**
 * Mask class-mixed runs inside a literal affix of an identifier position.
 *
 * The affix was recovered by comparing identifier values, so a run that looks like
 * identifier material almost certainly is: it reached the template only because every
 * member happened to share it.
 */
export function maskAffix(affix: string): string {
    return affix.replace(MASKABLE_RUN_PATTERN, (run) => {
        const mixedCase = hasAsciiUpper(run) && hasAsciiLower(run);
        const alphanumeric = hasAsciiLetter(run) && hasAsciiDigit(run);
        return mixedCase || alphanumeric ? `<x${run.length}>` : run;
    });
}
