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

export interface NameToken {
    readonly kind: TokenKind;
    readonly value: string;
}

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
        const candidate = parts[cut - 1]!.toLowerCase();
        if (!KNOWN_EXTENSIONS.has(candidate) || candidate.length > MAX_SUFFIX_TOKEN_LENGTH) break;
        cut--;
    }
    return { stem: parts.slice(0, cut).join("."), suffix: parts.slice(cut).join(".").toLowerCase() };
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_DIGEST_PATTERN = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9\-_=]+$/;
const DELIMITED_DATE_PATTERN = /^(\d{4})[-_](\d{2})[-_](\d{2})$/;
const COMPACT_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

function charClassCount(value: string): number {
    let classes = 0;
    for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[-_=]/]) if (pattern.test(value)) classes++;
    return classes;
}

function meanRunLength(value: string): number {
    const runs = value.match(/[A-Za-z]+|[0-9]+/g) ?? [];
    if (runs.length === 0) return 0;
    return runs.reduce((total, run) => total + run.length, 0) / runs.length;
}

function caseTransitions(value: string): number {
    let flips = 0;
    for (let i = 1; i < value.length; i++) {
        const before = value[i - 1]!;
        const after = value[i]!;
        if (!/[A-Za-z]/.test(before) || !/[A-Za-z]/.test(after)) continue;
        if ((before === before.toUpperCase()) !== (after === after.toUpperCase())) flips++;
    }
    return flips;
}

function fractionOf(value: string, pattern: RegExp): number {
    return (value.match(pattern) ?? []).length / value.length;
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
    if (HEX_DIGEST_PATTERN.test(value)) return true;
    if (value.length < MIN_OPAQUE_ID_LENGTH) return false;
    if (!BASE64URL_PATTERN.test(value)) return false;
    if (charClassCount(value) < MIN_OPAQUE_ID_CHAR_CLASSES) return false;

    const flipBudget = Math.max(MIN_OPAQUE_ID_CASE_FLIPS, Math.floor(value.length / OPAQUE_ID_CASE_FLIP_DIVISOR));
    if (caseTransitions(value) >= flipBudget) return true;

    if (fractionOf(value, /[-_=]/g) > MAX_OPAQUE_ID_SEPARATOR_FRACTION) return false;
    return meanRunLength(value) <= MAX_OPAQUE_ID_MEAN_RUN && fractionOf(value, /[0-9]/g) >= MIN_OPAQUE_ID_DIGIT_FRACTION;
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

const EMBEDDED_DATE_PATTERN = /(?<![0-9])(?:\d{4}[-_]\d{2}[-_]\d{2}|\d{8})(?![0-9])/g;

function pushRuns(text: string, into: NameToken[]): void {
    for (const run of text.matchAll(/[A-Za-z]+|[0-9]+|[-_=]+/g)) {
        const value = run[0];
        const kind: TokenKind = /^[0-9]/.test(value) ? "digit" : /^[A-Za-z]/.test(value) ? "alpha" : "delim";
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
    for (const match of segment.matchAll(/[A-Za-z0-9\-_=]+|[^A-Za-z0-9\-_=]+/g)) {
        const value = match[0];
        if (!/[A-Za-z0-9]/.test(value)) {
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
        tokens.push(...tokenizeSegment(parts[i]!));
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

export interface ValueClass {
    readonly tokenClass: SlotTokenClass;
    /** Digit width, when every value is a fixed-width number. */
    readonly width?: number;
    readonly minLength?: number;
    readonly maxLength?: number;
    /** The shared masked form, when the class is `pattern`. */
    readonly skeleton?: string;
}

/** Place a set of observed values on the lattice, most specific class first. */
export function classifyValues(values: readonly string[]): ValueClass {
    if (values.length === 0) return { tokenClass: "any" };
    if (values.length === 1) {
        const only = values[0]!;
        if (isDateToken(only)) return { tokenClass: "date" };
        if (isOpaqueId(only)) return { tokenClass: "opaque-id", minLength: only.length, maxLength: only.length };
        return { tokenClass: "constant" };
    }
    if (values.every((value) => isDateToken(value))) return { tokenClass: "date" };
    if (values.every((value) => /^[0-9]+$/.test(value))) {
        const width = values[0]!.length;
        return values.every((value) => value.length === width) ? { tokenClass: "digits-fixed", width } : { tokenClass: "digits" };
    }
    if (values.every((value) => /^[0-9a-fA-F]+$/.test(value) && value.length >= 4)) return { tokenClass: "hex" };
    if (values.every((value) => isOpaqueId(value))) {
        const lengths = values.map((value) => value.length);
        return { tokenClass: "opaque-id", minLength: Math.min(...lengths), maxLength: Math.max(...lengths) };
    }
    if (values.every((value) => /^[A-Za-z]+$/.test(value))) return { tokenClass: "word" };
    const skeletons = new Set(values.map((value) => maskSegment(value)));
    if (skeletons.size === 1) {
        const skeleton = [...skeletons][0]!;
        if (skeleton.includes(DIGIT_SYMBOL) || skeleton.includes(ID_SYMBOL) || skeleton.includes(DATE_SYMBOL)) {
            return { tokenClass: "pattern", skeleton };
        }
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
    let prefix = values[0]!;
    for (const value of values) {
        let i = 0;
        while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
        prefix = prefix.slice(0, i);
        if (!prefix) break;
    }
    let suffix = values[0]!.slice(prefix.length);
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
    return affix.replace(/[A-Za-z0-9]{3,}/g, (run) => {
        const mixedCase = /[A-Z]/.test(run) && /[a-z]/.test(run);
        const alphanumeric = /[A-Za-z]/.test(run) && /[0-9]/.test(run);
        return mixedCase || alphanumeric ? `<x${run.length}>` : run;
    });
}
