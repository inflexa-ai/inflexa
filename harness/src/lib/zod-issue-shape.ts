/**
 * The shape of a Zod validation failure, with no value of the input in it.
 *
 * The span and the log of a rejected tool call may not carry the arguments of
 * the model. A Zod `message` can quote the input, and so can the `keys` of an
 * `unrecognized_keys` issue and the string segments of a path under a record.
 * Thus each entry is built only from parts that the schema defines:
 *
 *  - the path, where a string segment is kept only when the schema declares
 *    that key, and each other string segment becomes `*`. An array index is
 *    kept as a number.
 *  - the issue `code`.
 *  - schema-side detail: the `expected` type, the `origin` and bound of a size
 *    check, the string `format`, the divisor, the allowed literals, and the
 *    discriminator of a union. For `unrecognized_keys`, only the count of keys.
 *
 * Example: `runId: invalid_type (expected string)`.
 */

import type { z } from "zod";

/** The most issues that one failure describes. */
const MAX_ISSUES = 10;

/** The cap of one entry, in characters. */
const MAX_ENTRY_CHARS = 200;

/** Describe the issues of `error` against `schema`, one entry for each issue. */
export function describeZodIssueShapes(error: z.ZodError, schema: z.ZodType): string[] {
    const entries = error.issues.slice(0, MAX_ISSUES).map((issue) => {
        const detail = issueDetail(issue);
        const entry = `${schemaPath(schema, issue.path)}: ${issue.code}${detail === undefined ? "" : ` (${detail})`}`;
        return entry.length > MAX_ENTRY_CHARS ? `${entry.slice(0, MAX_ENTRY_CHARS - 1)}…` : entry;
    });
    const rest = error.issues.length - MAX_ISSUES;
    if (rest > 0) entries.push(`+${rest} more issues`);
    return entries;
}

function issueDetail(issue: z.core.$ZodIssue): string | undefined {
    switch (issue.code) {
        case "invalid_type":
            return `expected ${issue.expected}`;
        case "too_small":
            return `${issue.origin} ${issue.exact === true ? "exactly" : "min"} ${issue.minimum}`;
        case "too_big":
            return `${issue.origin} ${issue.exact === true ? "exactly" : "max"} ${issue.maximum}`;
        case "invalid_format":
            return `format ${issue.format}`;
        case "not_multiple_of":
            return `divisor ${issue.divisor}`;
        case "unrecognized_keys":
            return `${issue.keys.length} keys`;
        case "invalid_value":
            return `expected ${issue.values.map(String).join("|")}`;
        case "invalid_union":
            return issue.discriminator === undefined ? undefined : `discriminator ${issue.discriminator}`;
        default:
            return undefined;
    }
}

/** The path of an issue, with each string segment that the schema does not declare replaced by `*`. */
function schemaPath(schema: z.ZodType, path: readonly PropertyKey[]): string {
    if (path.length === 0) return "(root)";
    let current: z.core.$ZodType | undefined = schema;
    const segments = path.map((segment) => {
        if (typeof segment === "number") {
            current = current === undefined ? undefined : elementOf(current, segment);
            return String(segment);
        }
        const field: z.core.$ZodType | undefined = current === undefined || typeof segment !== "string" ? undefined : fieldOf(current, segment);
        current = field;
        return field === undefined ? "*" : String(segment);
    });
    return segments.join(".");
}

/** The schema of the declared field `key`, looking through wrappers and unions. */
function fieldOf(schema: z.core.$ZodType, key: string): z.core.$ZodType | undefined {
    const def = (unwrap(schema) as z.core.$ZodTypes)._zod.def;
    if (def.type === "object") return Object.hasOwn(def.shape, key) ? def.shape[key] : undefined;
    if (def.type === "union") {
        for (const option of def.options) {
            const field = fieldOf(option, key);
            if (field !== undefined) return field;
        }
    }
    if (def.type === "intersection") return fieldOf(def.left, key) ?? fieldOf(def.right, key);
    return undefined;
}

function elementOf(schema: z.core.$ZodType, index: number): z.core.$ZodType | undefined {
    const def = (unwrap(schema) as z.core.$ZodTypes)._zod.def;
    if (def.type === "array") return def.element;
    if (def.type === "tuple") return def.items[index] ?? def.rest ?? undefined;
    return undefined;
}

function unwrap(schema: z.core.$ZodType): z.core.$ZodType {
    let current = schema;
    for (let depth = 0; depth < 16; depth++) {
        const def = (current as z.core.$ZodTypes)._zod.def;
        switch (def.type) {
            case "optional":
            case "nullable":
            case "default":
            case "prefault":
            case "nonoptional":
            case "catch":
            case "readonly":
                current = def.innerType;
                break;
            case "pipe":
                current = def.in;
                break;
            case "lazy":
                current = def.getter();
                break;
            default:
                return current;
        }
    }
    return current;
}
