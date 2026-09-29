/**
 * The local slots of a template: the slots whose value is a fact of the
 * machine (a path, a column name, a level label, a design formula). The
 * service renders such a slot as its marker `{{name}}` and never sees its
 * value; the host binds the value here, after the render and before the
 * write, thus the value never leaves the machine.
 *
 * `bindLocalSlots` is a copy of the reference implementation the knowledge
 * service exports (`src/render/render.ts` of the service). The two must give
 * the same bytes: a marked render bound here equals a full render of the
 * service for the same values. Keep the literal rules in step with the
 * service when a slot type is added.
 */

import type { TemplateParameter } from "./client.js";

/** A slot value: a scalar, or a list of strings. */
export type LocalSlotValue = string | number | boolean | readonly string[];

/** One refusal of a local value, in the shape of a render rejection issue. */
export interface LocalSlotIssue {
    readonly slot: string;
    readonly reason: string;
    readonly permitted?: readonly string[];
}

/** One bound slot as the decision record keeps it: the value, its source, and the lines that carried its marker. */
export interface BoundLocalSlot {
    readonly name: string;
    readonly value: LocalSlotValue;
    readonly source: "caller" | "default";
    readonly adaptable: true;
    readonly default_source?: string;
    readonly lines: readonly number[];
    /** The `read` flag the service computed for the slot on the marked render, when it has a `when` condition. */
    readonly read?: boolean;
}

export type BindLocalSlotsResult =
    | { readonly ok: false; readonly issues: readonly LocalSlotIssue[] }
    | { readonly ok: true; readonly script: string; readonly slots: readonly BoundLocalSlot[] };

/** The local slots of a contract, in the order the template declares them. */
export function localParameters(parameters: readonly TemplateParameter[]): TemplateParameter[] {
    return parameters.filter((parameter) => parameter.local === true);
}

const FORMULA_PATTERN = /^~\s*[A-Za-z0-9_.+*:()\s-]+$/;

/** Check one caller value against the contract of its slot, as the renderer of the service does. */
export function validateLocalSlot(parameter: TemplateParameter, value: unknown): LocalSlotIssue | undefined {
    const slot = parameter.name;
    const permitted = parameter.enum;
    switch (parameter.type) {
        case "string":
        case "formula": {
            if (typeof value !== "string" || value.length === 0) return { slot, reason: "a non-empty string is required" };
            if (parameter.type === "formula" && !FORMULA_PATTERN.test(value))
                return { slot, reason: "a formula must start with ~ and hold only names, +, :, *, and parentheses" };
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
        default:
            // The contract is a loose object of the wire, thus a type this host does not know is possible. It is
            // refused, never rendered as text, because a wrong literal is a wrong script.
            return { slot, reason: `the slot type ${parameter.type} is not one this host renders` };
    }
}

/** A slot value as a literal of the language: R gives `TRUE` and `c(...)`, Python gives `True` and `[...]`. */
function literal(language: string, parameter: TemplateParameter, value: LocalSlotValue): string {
    const python = language === "python";
    switch (parameter.type) {
        case "string":
            return JSON.stringify(String(value));
        case "formula":
            return String(value);
        case "number":
        case "integer":
            return String(value);
        case "boolean":
            return python ? (value ? "True" : "False") : value ? "TRUE" : "FALSE";
        case "string_list": {
            const items = Array.isArray(value) ? value : [String(value)];
            const rendered = items.map((item) => JSON.stringify(String(item))).join(", ");
            return python ? `[${rendered}]` : `c(${rendered})`;
        }
        default:
            throw new Error(`unhandled slot type: ${parameter.type}`);
    }
}

/** The literal of an optional slot that has no value: R keeps the type of the slot, Python has one absent scalar and an empty list. */
function absentLiteral(language: string, type: string): string {
    if (language === "python") return type === "string_list" ? "[]" : "None";
    switch (type) {
        case "string":
            return "NA_character_";
        case "integer":
            return "NA_integer_";
        case "number":
            return "NA_real_";
        case "boolean":
            return "NA";
        case "string_list":
            return "character(0)";
        default:
            return "NULL";
    }
}

/** The marker of a slot as the service leaves it in a marked render. */
export function slotMarker(name: string): string {
    return `{{${name}}}`;
}

/**
 * Bind the local values into a marked script. Each local marker takes the
 * literal of its value, else of the default of the slot, else the absent
 * literal when the slot is optional. A required local slot with no value
 * and no default is an issue, and so is a value the contract refuses. The
 * report names the source of each bound slot and keeps the `read` flag of
 * the marked report of the service.
 */
export function bindLocalSlots(
    template: { readonly language: string; readonly parameters: readonly TemplateParameter[] },
    script: string,
    localValues: Readonly<Record<string, unknown>>,
    marked: readonly { readonly name: string; readonly read?: boolean }[] = [],
): BindLocalSlotsResult {
    const issues: LocalSlotIssue[] = [];
    const locals = localParameters(template.parameters);
    const byName = new Map(locals.map((parameter) => [parameter.name, parameter]));
    for (const name of Object.keys(localValues)) {
        if (!byName.has(name)) issues.push({ slot: name, reason: "the template has no such local slot", permitted: [...byName.keys()] });
    }
    const values = new Map<string, LocalSlotValue>();
    const slots: BoundLocalSlot[] = [];
    for (const parameter of locals) {
        const given = localValues[parameter.name];
        if (given !== undefined) {
            const issue = validateLocalSlot(parameter, given);
            if (issue) {
                issues.push(issue);
                continue;
            }
            // Validated above: a string, a finite number, a boolean, or a list of strings.
            const value = given as LocalSlotValue;
            values.set(parameter.name, value);
            slots.push({ name: parameter.name, value, source: "caller", adaptable: true, lines: [] });
        } else if (parameter.default !== undefined) {
            // The contract is loose on the wire; a default is a scalar or a list of strings by the contract of the service,
            // and the service renders whatever it holds, thus only an absent default is absent here too.
            const value = parameter.default as LocalSlotValue;
            values.set(parameter.name, value);
            slots.push({
                name: parameter.name,
                value,
                source: "default",
                adaptable: true,
                ...(parameter.default_source ? { default_source: parameter.default_source } : {}),
                lines: [],
            });
        } else if (parameter.required !== false) {
            issues.push({ slot: parameter.name, reason: "the local slot is required and has no value" });
        }
    }
    if (issues.length > 0) return { ok: false, issues };
    const bound = script.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (whole, name: string) => {
        const parameter = byName.get(name);
        if (!parameter) return whole;
        const value = values.get(name);
        return value === undefined ? absentLiteral(template.language, parameter.type) : literal(template.language, parameter, value);
    });
    const lines = bound.split("\n");
    const readByName = new Map(marked.flatMap((entry) => (entry.read === undefined ? [] : [[entry.name, entry.read] as const])));
    const located = slots.map((entry) => ({
        ...entry,
        lines: script.split("\n").flatMap((line, index) => (line.includes(slotMarker(entry.name)) && index < lines.length ? [index + 1] : [])),
        ...(readByName.has(entry.name) ? { read: readByName.get(entry.name) } : {}),
    }));
    return { ok: true, script: bound, slots: located };
}
