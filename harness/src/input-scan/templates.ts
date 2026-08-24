/**
 * Stage 3 — name-template mining within one directory context.
 *
 * Literal versus slot is decided by per-position distinct counts: a position whose
 * token is the same in every member is literal text, and one that varies is a slot.
 * Groups that differ in exactly one position, or only in extension, merge — variance
 * inside a set is a property of the set, never a partition key.
 *
 * Proliferation is bounded three ways, because a template per file is the same failure
 * as no templates at all: a prefix trie claims residual singletons that share literal
 * text, a family collapse claims singletons that share only a token-kind sequence
 * (one template for the family costs less than one template each), and a catch-all
 * claims the rest where the repetition across directories is itself the structure.
 */

import type { MemberFile, SlotLocation } from "./set-types.js";
import { DATE_SYMBOL, DIGIT_SYMBOL, ID_SYMBOL, classifyValues, commonAffixes, isDateToken, maskAffix, skeletonOf, tokenizeName } from "./tokens.js";
import type { NameToken, SlotTokenClass, TokenKind } from "./tokens.js";
import { MAX_SLOT_SAMPLE_VALUES, MIN_AFFIX_LENGTH, MIN_CATCH_ALL_MEMBERS, MIN_FAMILY_SET_MEMBERS, MIN_PREFIX_SET_MEMBERS } from "./tuning.js";

/** A member with the directory-slot values of the context it was found in. */
export interface ContextFile extends MemberFile {
    readonly varValues: readonly string[];
}

export interface MinedItem {
    readonly file: ContextFile;
    readonly tokens: readonly NameToken[];
    readonly suffix: string;
    readonly skeleton: string;
}

export type MinedKind = "tokens" | "prefix" | "family" | "catch-all";

export interface MinedGroup {
    readonly kind: MinedKind;
    readonly tokenKinds: readonly TokenKind[];
    /** The shared literal head, when the group was claimed by prefix mining. */
    readonly prefixTokens: readonly NameToken[];
    readonly suffix: string;
    /** Extension chains observed across the members, with counts. */
    readonly suffixes: Map<string, number>;
    items: MinedItem[];
    distinct?: number[];
}

/** A slot before the assembly stamps it with an id. */
export interface DraftSlot {
    readonly location: SlotLocation;
    readonly index: number;
    readonly tokenClass: SlotTokenClass;
    readonly width?: number;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly skeleton?: string;
    readonly prefix?: string;
    readonly suffix?: string;
    readonly distinctValues: number;
    readonly sampleValues: readonly string[];
    /** The complete value set — bounded projection is `sampleValues`. */
    readonly values: readonly string[];
    /** The value each member carries, aligned to the order the raw values arrived in. */
    readonly memberValues: readonly string[];
    sameAs?: number;
    crossCheckMismatches?: number;
}

export type DraftSegment = { readonly kind: "literal"; readonly text: string } | { readonly kind: "slot"; readonly slot: number };

function toItem(file: ContextFile): MinedItem {
    const { tokens, suffix } = tokenizeName(file.name);
    return { file, tokens, suffix, skeleton: skeletonOf(tokens) };
}

function newGroup(kind: MinedKind, seed: Partial<MinedGroup> & { suffix: string }): MinedGroup {
    return { kind, tokenKinds: [], prefixTokens: [], suffixes: new Map(), items: [], ...seed };
}

function firstPass(items: readonly MinedItem[]): MinedGroup[] {
    const groups = new Map<string, MinedGroup>();
    for (const item of items) {
        const key = `${item.skeleton} ${item.suffix}`;
        let group = groups.get(key);
        if (!group) {
            group = newGroup("tokens", { tokenKinds: item.tokens.map((token) => token.kind), suffix: item.suffix });
            groups.set(key, group);
        }
        group.items.push(item);
        group.suffixes.set(item.suffix, (group.suffixes.get(item.suffix) ?? 0) + 1);
    }
    return [...groups.values()];
}

function distinctCounts(group: MinedGroup): number[] {
    if (!group.distinct) {
        group.distinct = group.tokenKinds.map((_, position) => {
            const seen = new Set<string>();
            for (const item of group.items) seen.add(item.tokens[position]?.value ?? "");
            return seen.size;
        });
    }
    return group.distinct;
}

function isVariable(group: MinedGroup, position: number): boolean {
    if (group.tokenKinds[position] === "id") return true;
    return distinctCounts(group)[position]! > 1;
}

function mergeGroups(groups: readonly MinedGroup[]): MinedGroup {
    const head = groups[0]!;
    const suffixes = new Map<string, number>();
    const items: MinedItem[] = [];
    for (const group of groups) {
        items.push(...group.items);
        for (const [suffix, count] of group.suffixes) suffixes.set(suffix, (suffixes.get(suffix) ?? 0) + count);
    }
    return { kind: head.kind, tokenKinds: head.tokenKinds, prefixTokens: head.prefixTokens, suffix: head.suffix, suffixes, items };
}

/**
 * Merge groups differing in exactly one alphabetic or numeric position to a fixpoint,
 * then fold groups whose stems agree once their slots are wildcarded.
 *
 * Without the first pass a categorical position reads as unrelated groups, and the
 * agent is handed the very split it exists to decide against. Without the second,
 * members that differ only in compression become two sets that a reader has to notice
 * are one.
 */
function mergeVariants(groups: readonly MinedGroup[]): MinedGroup[] {
    let current = [...groups];
    for (;;) {
        const families = new Map<string, MinedGroup[]>();
        for (const group of current) {
            const key = `${group.tokenKinds.join(",")} ${group.suffix}`;
            const bucket = families.get(key);
            if (bucket) bucket.push(group);
            else families.set(key, [group]);
        }

        const next: MinedGroup[] = [];
        let merged = false;
        for (const family of families.values()) {
            if (family.length === 1) {
                next.push(family[0]!);
                continue;
            }
            const positions = family[0]!.tokenKinds.length;
            let mergedHere = false;
            for (let p = 0; p < positions && !mergedHere; p++) {
                const kind = family[0]!.tokenKinds[p];
                if (kind !== "alpha" && kind !== "digit") continue;
                const buckets = new Map<string, MinedGroup[]>();
                for (const group of family) {
                    // Every member of a group shares its literal tokens, so the first row
                    // identifies the whole group at this position.
                    const row = group.items[0]!.tokens;
                    const key = row.map((token, i) => (i === p || isVariable(group, i) ? "" : token.value)).join(" ");
                    const bucket = buckets.get(key);
                    if (bucket) bucket.push(group);
                    else buckets.set(key, [group]);
                }
                if ([...buckets.values()].every((bucket) => bucket.length === 1)) continue;
                for (const bucket of buckets.values()) next.push(bucket.length === 1 ? bucket[0]! : mergeGroups(bucket));
                mergedHere = true;
                merged = true;
            }
            if (!mergedHere) next.push(...family);
        }

        current = next;
        if (!merged) break;
    }

    const byStem = new Map<string, MinedGroup[]>();
    for (const group of current) {
        const row = group.items[0]!.tokens;
        const key = `${group.tokenKinds.join(",")} ${row.map((token, i) => (isVariable(group, i) ? "" : token.value)).join(" ")}`;
        const bucket = byStem.get(key);
        if (bucket) bucket.push(group);
        else byStem.set(key, [group]);
    }
    return [...byStem.values()].map((bucket) => (bucket.length === 1 ? bucket[0]! : mergeGroups(bucket)));
}

function symbolOf(token: NameToken): string {
    if (token.kind === "id") return ID_SYMBOL;
    if (token.kind === "digit") return DIGIT_SYMBOL;
    if (token.kind === "date") return DATE_SYMBOL;
    return token.value;
}

/**
 * Claim residual singletons by shared literal prefix, deepest node first.
 *
 * Children are claimed before their parent, so a specific prefix wins over the general
 * one it extends, and a prefix earns a set only once it covers enough files to be
 * cheaper than the singletons it replaces.
 */
function minePrefixes(residue: readonly MinedItem[]): { sets: MinedGroup[]; rest: MinedItem[] } {
    interface TrieNode {
        readonly children: Map<string, TrieNode>;
        readonly items: MinedItem[];
        readonly token?: NameToken;
    }

    const bySuffix = new Map<string, MinedItem[]>();
    for (const item of residue) {
        const bucket = bySuffix.get(item.suffix);
        if (bucket) bucket.push(item);
        else bySuffix.set(item.suffix, [item]);
    }

    const sets: MinedGroup[] = [];
    const rest: MinedItem[] = [];
    for (const [suffix, items] of bySuffix) {
        if (items.length < MIN_PREFIX_SET_MEMBERS) {
            rest.push(...items);
            continue;
        }
        const root: TrieNode = { children: new Map(), items: [] };
        for (const item of items) {
            let node = root;
            node.items.push(item);
            for (const token of item.tokens) {
                const key = symbolOf(token);
                let child = node.children.get(key);
                if (!child) {
                    child = { children: new Map(), items: [], token };
                    node.children.set(key, child);
                }
                child.items.push(item);
                node = child;
            }
        }

        const taken = new Set<MinedItem>();
        const claim = (node: TrieNode, prefixTokens: readonly NameToken[]): void => {
            for (const child of node.children.values()) claim(child, [...prefixTokens, child.token!]);
            const free = node.items.filter((item) => !taken.has(item));
            const literals = prefixTokens.filter((token) => token.kind === "alpha").length;
            if (free.length < MIN_PREFIX_SET_MEMBERS || literals < 1) return;
            for (const item of free) taken.add(item);
            const suffixes = new Map([[suffix, free.length]]);
            sets.push(newGroup("prefix", { prefixTokens, suffix, suffixes, items: free }));
        };
        claim(root, []);
        rest.push(...items.filter((item) => !taken.has(item)));
    }
    return { sets, rest };
}

/**
 * Collapse singletons that share a token-kind sequence into one set.
 *
 * A flat directory of differently-named tables has one shape even though no two names
 * differ in a single position. One template for the family is a shorter description
 * than one template each, which is the only reason to prefer it — so it applies only
 * once the family is large enough to pay for the generality it gives up.
 */
function collapseFamilies(residue: readonly MinedItem[]): { sets: MinedGroup[]; rest: MinedItem[] } {
    const families = new Map<string, MinedItem[]>();
    for (const item of residue) {
        const key = `${item.tokens.map((token) => token.kind).join(",")} ${item.suffix}`;
        const bucket = families.get(key);
        if (bucket) bucket.push(item);
        else families.set(key, [item]);
    }

    const sets: MinedGroup[] = [];
    const rest: MinedItem[] = [];
    for (const items of families.values()) {
        if (items.length < MIN_FAMILY_SET_MEMBERS) {
            rest.push(...items);
            continue;
        }
        const head = items[0]!;
        sets.push(
            newGroup("family", {
                tokenKinds: head.tokens.map((token) => token.kind),
                suffix: head.suffix,
                suffixes: new Map([[head.suffix, items.length]]),
                items: [...items],
            }),
        );
    }
    return { sets, rest };
}

/**
 * Fold what is left of a cross-directory context into one set.
 *
 * Where the same directory shape repeats, that repetition is the structure, and the
 * residual names inside it are one set whatever they are called. Extension
 * disagreement is carried as the format census, never used to split.
 */
export function catchAll(residue: readonly MinedItem[], hasDirectorySlot: boolean): { sets: MinedGroup[]; rest: MinedItem[] } {
    if (!hasDirectorySlot || residue.length < MIN_CATCH_ALL_MEMBERS) return { sets: [], rest: [...residue] };
    const suffixes = new Map<string, number>();
    for (const item of residue) suffixes.set(item.suffix, (suffixes.get(item.suffix) ?? 0) + 1);
    return {
        sets: [newGroup("catch-all", { suffix: [...suffixes.keys()].sort((a, b) => a.localeCompare(b, "en")).join(","), suffixes, items: [...residue] })],
        rest: [],
    };
}

/** Mine one directory context: every file whose directory path instantiates one template. */
export function mineContext(files: readonly ContextFile[]): { sets: MinedGroup[]; residue: MinedItem[] } {
    const groups = mergeVariants(firstPass(files.map(toItem)));
    const sets: MinedGroup[] = [];
    const singletons: MinedItem[] = [];
    for (const group of groups) {
        if (group.items.length >= 2) sets.push(group);
        else singletons.push(group.items[0]!);
    }
    const prefixes = minePrefixes(singletons);
    sets.push(...prefixes.sets);
    const families = collapseFamilies(prefixes.rest);
    sets.push(...families.sets);
    return { sets, residue: families.rest };
}

/** Describe one varying position: its class, its cardinality, and a bounded value sample. */
export function describeSlot(rawValues: readonly string[], location: SlotLocation, index: number): DraftSlot {
    const distinct = [...new Set(rawValues)];
    let { prefix, suffix } = commonAffixes(distinct);
    if (prefix.length < MIN_AFFIX_LENGTH) prefix = "";
    if (suffix.length < MIN_AFFIX_LENGTH) suffix = "";
    // A number and a date are each one value: slicing a shared year off them would
    // report a date as a literal prefix plus a pattern.
    if (distinct.every((value) => /^[0-9]*$/.test(value)) || distinct.every((value) => isDateToken(value))) {
        prefix = "";
        suffix = "";
    }
    const strip = (value: string): string => value.slice(prefix.length, suffix ? value.length - suffix.length : undefined);
    const cores = distinct.map(strip);
    const observed = classifyValues(cores);
    const sorted = [...cores].sort((a, b) => a.localeCompare(b, "en"));
    return {
        location,
        index,
        tokenClass: observed.tokenClass,
        ...(observed.width !== undefined ? { width: observed.width } : {}),
        ...(observed.minLength !== undefined ? { minLength: observed.minLength, maxLength: observed.maxLength } : {}),
        ...(observed.skeleton !== undefined ? { skeleton: observed.skeleton } : {}),
        ...(prefix ? { prefix } : {}),
        ...(suffix ? { suffix } : {}),
        distinctValues: distinct.length,
        sampleValues: sorted.slice(0, MAX_SLOT_SAMPLE_VALUES),
        values: cores,
        memberValues: rawValues.map(strip),
    };
}

/** The template token a slot renders as. */
export function slotToken(slot: DraftSlot): string {
    switch (slot.tokenClass) {
        case "digits-fixed":
            return `<digits:${slot.width}>`;
        case "pattern":
            return `<pattern:${slot.skeleton}>`;
        default:
            return `<${slot.tokenClass}>`;
    }
}

function affixText(slot: DraftSlot, affix: string): string {
    return slot.tokenClass === "opaque-id" ? maskAffix(affix) : affix;
}

function suffixLiteral(group: MinedGroup): string {
    if (group.suffixes.size <= 1) return group.suffix ? `.${group.suffix}` : "";
    const suffixes = [...group.suffixes.keys()].sort((a, b) => a.localeCompare(b, "en"));
    return `.{${suffixes.join(",")}}`;
}

/**
 * The name half of a set's template: its literal text, its slots, and the order they
 * appear in. Directory slots are prepended by the assembly, which knows the context.
 */
export function describeGroup(group: MinedGroup): { slots: DraftSlot[]; segments: DraftSegment[] } {
    const slots: DraftSlot[] = [];
    const segments: DraftSegment[] = [];

    const pushSlot = (slot: DraftSlot): void => {
        if (slot.prefix) segments.push({ kind: "literal", text: affixText(slot, slot.prefix) });
        segments.push({ kind: "slot", slot: slots.length });
        if (slot.suffix) segments.push({ kind: "literal", text: affixText(slot, slot.suffix) });
        slots.push(slot);
    };

    if (group.kind === "catch-all") {
        pushSlot(
            describeSlot(
                group.items.map((item) => item.file.name),
                "name",
                0,
            ),
        );
        return { slots, segments };
    }

    if (group.kind === "prefix") {
        segments.push({ kind: "literal", text: group.prefixTokens.map((token) => token.value).join("") });
        const rests = group.items.map((item) =>
            item.tokens
                .slice(group.prefixTokens.length)
                .map((token) => token.value)
                .join(""),
        );
        pushSlot(describeSlot(rests, "name", group.prefixTokens.length));
        const literal = suffixLiteral(group);
        if (literal) segments.push({ kind: "literal", text: literal });
        return { slots, segments };
    }

    for (let i = 0; i < group.tokenKinds.length; i++) {
        const values = group.items.map((item) => item.tokens[i]?.value ?? "");
        const distinct = new Set(values);
        if (distinct.size === 1 && group.tokenKinds[i] !== "id") {
            segments.push({ kind: "literal", text: [...distinct][0]! });
            continue;
        }
        pushSlot(describeSlot(values, "name", i));
    }
    const literal = suffixLiteral(group);
    if (literal) segments.push({ kind: "literal", text: literal });
    return { slots, segments };
}
