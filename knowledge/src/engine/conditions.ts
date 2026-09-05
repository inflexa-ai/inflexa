/**
 * Condition evaluation: one predicate over one Situation field.
 *
 * The engine is code over decision tables, not a reasoner. Each operator has
 * one meaning, and a condition over an absent field evaluates as the null
 * tests define it: `is_null` holds, `not_null` fails, and every comparison
 * fails. Thus a rule that needs a fact the caller did not give never fires
 * by accident.
 */

import type { Condition, Situation } from "../model.js";

type Scalar = string | number | boolean | null;

function fieldValue(situation: Situation, field: string): unknown {
    return (situation as Record<string, unknown>)[field];
}

function isAbsent(value: unknown): boolean {
    return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function asList(value: Condition["value"]): Scalar[] {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

export function evaluateCondition(condition: Condition, situation: Situation): boolean {
    const actual = fieldValue(situation, condition.field);
    switch (condition.op) {
        case "is_null":
            return isAbsent(actual);
        case "not_null":
            return !isAbsent(actual);
        case "eq":
            return !isAbsent(actual) && actual === condition.value;
        case "ne":
            return !isAbsent(actual) && actual !== condition.value;
        case "in":
            return !isAbsent(actual) && asList(condition.value).includes(actual as Scalar);
        case "not_in":
            return !isAbsent(actual) && !asList(condition.value).includes(actual as Scalar);
        case "contains":
            return Array.isArray(actual) && asList(condition.value).some((wanted) => (actual as Scalar[]).includes(wanted));
        case "lt":
            return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
        case "lte":
            return typeof actual === "number" && typeof condition.value === "number" && actual <= condition.value;
        case "gt":
            return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
        case "gte":
            return typeof actual === "number" && typeof condition.value === "number" && actual >= condition.value;
        default: {
            const unreachable: never = condition.op;
            throw new Error(`unhandled condition operator: ${String(unreachable)}`);
        }
    }
}

/** Render one condition as a short human-readable predicate, for a `match: none` answer. */
export function describeCondition(condition: Condition): string {
    const value = condition.value === undefined ? "" : ` ${JSON.stringify(condition.value)}`;
    return `${condition.field} ${condition.op}${value}`;
}
