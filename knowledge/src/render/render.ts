/**
 * The template renderer.
 *
 * A template body is logic-light. It holds three constructs and nothing else:
 *
 *   {{name}}                         the value of a slot, rendered as a literal of the language
 *   {{#if name}} ... {{/if}}         kept when the slot is truthy
 *   {{#unless name}} ... {{/unless}} kept when the slot is falsy
 *
 * The caller fills only the slots that the contract marks adaptable. A pinned
 * slot comes from the template default, and a caller that sends one gets a
 * validation error, because a pinned value carries a source and a curator
 * signed it. Each adaptable slot must land on a line that carries the marker
 * `# [adaptable: name]`, thus a later edit lands in a known place and the
 * decision record can list it.
 */

import type { Template, TemplateParameter } from "../model.js";

export type SlotValue = string | number | boolean | readonly string[];

export interface SlotIssue {
    readonly slot: string;
    readonly reason: string;
    readonly permitted?: readonly string[];
}

export interface SlotReportEntry {
    readonly name: string;
    readonly value: SlotValue;
    readonly source: "caller" | "default";
    readonly adaptable: boolean;
    readonly default_source?: string;
    /** 1-based line numbers of the rendered script that carry the slot. */
    readonly lines: readonly number[];
}

export type RenderResult =
    | { readonly ok: false; readonly issues: readonly SlotIssue[] }
    | { readonly ok: true; readonly script: string; readonly slots: readonly SlotReportEntry[] };

export const ADAPTABLE_MARKER = /#\s*\[adaptable:\s*([a-z][a-z0-9_]*)\]/g;

function rLiteral(parameter: TemplateParameter, value: SlotValue): string {
    switch (parameter.type) {
        case "string":
            return JSON.stringify(String(value));
        case "formula":
            return String(value);
        case "number":
        case "integer":
            return String(value);
        case "boolean":
            return value ? "TRUE" : "FALSE";
        case "string_list": {
            const items = Array.isArray(value) ? value : [String(value)];
            return `c(${items.map((item) => JSON.stringify(String(item))).join(", ")})`;
        }
        default: {
            const unreachable: never = parameter.type;
            throw new Error(`unhandled slot type: ${String(unreachable)}`);
        }
    }
}

function truthy(value: SlotValue | undefined): boolean {
    if (value === undefined) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.trim().length > 0;
    return value.length > 0;
}

const FORMULA_PATTERN = /^~\s*[A-Za-z0-9_.:*+\s()-]+$/;

/** Check one caller value against the contract of its slot. */
export function validateSlot(parameter: TemplateParameter, value: unknown): SlotIssue | undefined {
    const slot = parameter.name;
    const permitted = parameter.enum;
    switch (parameter.type) {
        case "string":
        case "formula": {
            if (typeof value !== "string" || value.length === 0) return { slot, reason: "a non-empty string is required" };
            if (parameter.type === "formula" && !FORMULA_PATTERN.test(value)) return { slot, reason: "a formula must start with ~ and hold only names, +, :, *, and parentheses" };
            if (permitted && !permitted.includes(value)) return { slot, reason: `the value "${value}" is not permitted`, permitted };
            if (parameter.pattern && !new RegExp(parameter.pattern).test(value)) return { slot, reason: `the value must match ${parameter.pattern}` };
            return undefined;
        }
        case "number":
        case "integer": {
            if (typeof value !== "number" || !Number.isFinite(value)) return { slot, reason: "a number is required" };
            if (parameter.type === "integer" && !Number.isInteger(value)) return { slot, reason: "an integer is required" };
            if (parameter.minimum !== undefined && value < parameter.minimum) return { slot, reason: `the value must be at least ${parameter.minimum}` };
            if (parameter.maximum !== undefined && value > parameter.maximum) return { slot, reason: `the value must be at most ${parameter.maximum}` };
            return undefined;
        }
        case "boolean":
            return typeof value === "boolean" ? undefined : { slot, reason: "a boolean is required" };
        case "string_list": {
            if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return { slot, reason: "a list of strings is required" };
            if (permitted) {
                const bad = value.find((item) => !permitted.includes(item));
                if (bad !== undefined) return { slot, reason: `the value "${bad}" is not permitted`, permitted };
            }
            return undefined;
        }
        default: {
            const unreachable: never = parameter.type;
            throw new Error(`unhandled slot type: ${String(unreachable)}`);
        }
    }
}

/** The slot names the body references, in the three constructs. */
export function bodySlotNames(body: string): Set<string> {
    const names = new Set<string>();
    for (const match of body.matchAll(/\{\{\s*(?:#if|#unless)?\s*([a-z][a-z0-9_]*)\s*\}\}/g)) names.add(match[1]!);
    return names;
}

/** The adaptable slots that no marked line carries. The build refuses such a template. */
export function unmarkedAdaptableSlots(template: Template, body: string): string[] {
    const marked = new Set<string>();
    for (const match of body.matchAll(ADAPTABLE_MARKER)) marked.add(match[1]!);
    return template.parameters.filter((parameter) => parameter.adaptable && !marked.has(parameter.name)).map((parameter) => parameter.name);
}

function expandBlocks(body: string, values: ReadonlyMap<string, SlotValue>): string {
    const block = /\{\{#(if|unless)\s+([a-z][a-z0-9_]*)\s*\}\}([\s\S]*?)\{\{\/\1\}\}/g;
    let previous = "";
    let current = body;
    // Blocks do not nest in the corpus, and a fixed point still handles an accidental nest one level at a time.
    while (previous !== current) {
        previous = current;
        current = current.replace(block, (_whole, kind: string, name: string, inner: string) => {
            const keep = kind === "if" ? truthy(values.get(name)) : !truthy(values.get(name));
            return keep ? inner : "";
        });
    }
    return current;
}

export function renderTemplate(template: Template, body: string, callerSlots: Readonly<Record<string, unknown>>): RenderResult {
    const issues: SlotIssue[] = [];
    const byName = new Map(template.parameters.map((parameter) => [parameter.name, parameter]));
    const adaptableNames = template.parameters.filter((parameter) => parameter.adaptable).map((parameter) => parameter.name);

    for (const name of Object.keys(callerSlots)) {
        const parameter = byName.get(name);
        if (!parameter) {
            issues.push({ slot: name, reason: "the template has no such slot", permitted: adaptableNames });
        } else if (!parameter.adaptable) {
            issues.push({ slot: name, reason: "the slot is pinned by the template and takes no caller value" });
        }
    }

    const values = new Map<string, SlotValue>();
    const report: SlotReportEntry[] = [];
    for (const parameter of template.parameters) {
        const given = callerSlots[parameter.name];
        if (parameter.adaptable && given !== undefined) {
            const issue = validateSlot(parameter, given);
            if (issue) {
                issues.push(issue);
                continue;
            }
            values.set(parameter.name, given as SlotValue);
            report.push({ name: parameter.name, value: given as SlotValue, source: "caller", adaptable: true, lines: [] });
        } else if (parameter.default !== undefined) {
            const value = parameter.default as SlotValue;
            values.set(parameter.name, value);
            report.push({
                name: parameter.name,
                value,
                source: "default",
                adaptable: parameter.adaptable,
                ...(parameter.default_source ? { default_source: parameter.default_source } : {}),
                lines: [],
            });
        } else if (parameter.adaptable && parameter.required !== false) {
            issues.push({ slot: parameter.name, reason: "the slot is required and has no default" });
        }
    }
    if (issues.length > 0) return { ok: false, issues };

    const expanded = expandBlocks(body, values);
    const script = expanded.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_whole, name: string) => {
        const parameter = byName.get(name);
        const value = values.get(name);
        if (!parameter || value === undefined) return "NULL";
        return rLiteral(parameter, value);
    });

    const lines = script.split("\n");
    const located = report.map((entry) => {
        const found: number[] = [];
        for (const match of expanded.split("\n").entries()) {
            if (match[1].includes(`{{${entry.name}}}`) || match[1].includes(`{{ ${entry.name} }}`)) found.push(match[0] + 1);
        }
        return { ...entry, lines: found.filter((line) => line <= lines.length) };
    });
    return { ok: true, script, slots: located };
}
