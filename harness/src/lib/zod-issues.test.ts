import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { hintForZodIssue } from "./zod-issues.js";

/** Parse `input` against `schema` and return the issues it produced. */
function issuesFor(schema: z.ZodType, input: unknown): z.core.$ZodIssue[] {
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    return parsed.success ? [] : parsed.error.issues;
}

const NestedSchema = z.object({
    findings: z.array(
        z.object({
            title: z.string(),
            references: z.array(z.object({ pmid: z.string() })),
        }),
    ),
});

describe("hintForZodIssue", () => {
    test("hints when an object field arrived as a JSON-encoded string", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });
        const input = { synthesis: JSON.stringify({ runId: "run-1" }) };

        const [issue] = issuesFor(schema, input);
        const hint = hintForZodIssue(issue!, input);

        expect(hint).toBeDefined();
        expect(hint).toContain("JSON-encoded string");
        expect(hint).toContain("object");
    });

    test("hints when an array field arrived as a JSON-encoded string", () => {
        const schema = z.object({ steps: z.array(z.string()) });
        const input = { steps: JSON.stringify(["a", "b"]) };

        const [issue] = issuesFor(schema, input);
        const hint = hintForZodIssue(issue!, input);

        expect(hint).toBeDefined();
        expect(hint).toContain("JSON-encoded string");
        expect(hint).toContain("array");
    });

    test("tolerates leading whitespace before the JSON opener", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });
        const input = { synthesis: '\n  {"runId":"run-1"}' };

        const [issue] = issuesFor(schema, input);

        expect(hintForZodIssue(issue!, input)).toBeDefined();
    });

    test("stays silent for a plain string that is not serialized JSON", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });
        const input = { synthesis: "hello" };

        const [issue] = issuesFor(schema, input);

        expect(hintForZodIssue(issue!, input)).toBeUndefined();
    });

    test("stays silent for a number where an object was expected", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });
        const input = { synthesis: 42 };

        const [issue] = issuesFor(schema, input);

        expect(hintForZodIssue(issue!, input)).toBeUndefined();
    });

    test("stays silent for a non-invalid_type issue", () => {
        const schema = z.object({ name: z.string().min(5) });
        const input = { name: "ab" };

        const [issue] = issuesFor(schema, input);

        expect(issue!.code).not.toBe("invalid_type");
        expect(hintForZodIssue(issue!, input)).toBeUndefined();
    });

    test("stays silent when a string was expected and a string-ish object arrived", () => {
        const schema = z.object({ note: z.string() });
        const input = { note: { text: "hi" } };

        const [issue] = issuesFor(schema, input);

        expect(hintForZodIssue(issue!, input)).toBeUndefined();
    });

    test("resolves a nested array-index path", () => {
        const input = {
            findings: [{ title: "t", references: JSON.stringify([{ pmid: "1" }]) }],
        };

        const [issue] = issuesFor(NestedSchema, input);

        expect(issue!.path).toEqual(["findings", 0, "references"]);
        expect(hintForZodIssue(issue!, input)).toBeDefined();
    });

    test("returns undefined for a path that does not resolve into the input", () => {
        const issue: z.core.$ZodIssue = {
            code: "invalid_type",
            expected: "object",
            path: ["findings", 3, "references", "deep"],
            message: "Invalid input: expected object, received string",
        };

        expect(() => hintForZodIssue(issue, { findings: [] })).not.toThrow();
        expect(hintForZodIssue(issue, { findings: [] })).toBeUndefined();
        expect(hintForZodIssue(issue, undefined)).toBeUndefined();
        expect(hintForZodIssue(issue, null)).toBeUndefined();
        expect(hintForZodIssue(issue, "not-an-object")).toBeUndefined();
    });
});
