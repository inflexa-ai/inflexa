import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { hintForZodIssue, repairToolInput } from "./zod-issues.js";

/** Parse `input` against `schema` and return the issues it produced. */
function issuesFor(schema: z.ZodType, input: unknown): z.core.$ZodIssue[] {
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    return parsed.success ? [] : parsed.error.issues;
}

/** Parse `input` against `schema` and hand the failure to `repairToolInput`. */
function repairAgainst(schema: z.ZodType, input: unknown): unknown | undefined {
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    return parsed.success ? undefined : repairToolInput(input, parsed.error);
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

    test("names the wrapper — not double encoding — when the value parses only after stripping", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });
        const input = { synthesis: '{"runId":"run-1"}</parameter>\n</invoke>' };

        const [issue] = issuesFor(schema, input);
        const hint = hintForZodIssue(issue!, input);

        expect(hint).toBeDefined();
        expect(hint).toContain("extra content wrapped around");
        expect(hint).toContain("</parameter>");
        expect(hint).not.toContain("JSON-encoded string");
    });

    test("names the wrapper for a fenced JSON object", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });
        const input = { synthesis: '```json\n{"runId":"run-1"}\n```' };

        const [issue] = issuesFor(schema, input);
        const hint = hintForZodIssue(issue!, input);

        expect(hint).toContain("extra content wrapped around");
        expect(hint).toContain("```");
    });

    test("bounds the quoted wrapper snippet", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });
        const input = { synthesis: `{"runId":"run-1"}</parameter>${" ".repeat(200)}</invoke>` };

        const [issue] = issuesFor(schema, input);
        const hint = hintForZodIssue(issue!, input)!;

        expect(hint).toBeDefined();
        expect(hint.length).toBeLessThan(400);
    });

    test("stays silent for a leading function-call fragment that cannot be salvaged", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });
        const input = { synthesis: '\n<parameter name="runId">fb0f43f5-1234' };

        const [issue] = issuesFor(schema, input);

        expect(() => hintForZodIssue(issue!, input)).not.toThrow();
        expect(hintForZodIssue(issue!, input)).toBeUndefined();
    });

    test("stays silent for a truncated JSON object", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });
        const input = { synthesis: '{"runId":"run-1", "findings": [{"title":' };

        const [issue] = issuesFor(schema, input);

        expect(hintForZodIssue(issue!, input)).toBeUndefined();
    });
});

describe("repairToolInput", () => {
    const SynthesisSchema = z.object({ synthesis: z.object({ runId: z.string(), findings: z.array(z.string()) }) });
    const payload = { runId: "run-1", findings: ["a", "b"] };

    test("repairs a complete JSON object carrying trailing function-call markup", () => {
        const input = { synthesis: `${JSON.stringify(payload)}</parameter>\n</invoke>` };

        const repaired = repairAgainst(SynthesisSchema, input);

        expect(repaired).toEqual({ synthesis: payload });
        expect(SynthesisSchema.safeParse(repaired).success).toBe(true);
    });

    test("repairs a bare trailing </parameter> with no </invoke>", () => {
        const input = { synthesis: `${JSON.stringify(payload)}</parameter>  ` };

        expect(repairAgainst(SynthesisSchema, input)).toEqual({ synthesis: payload });
    });

    test("repairs a fenced JSON object", () => {
        const input = { synthesis: `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` };

        expect(repairAgainst(SynthesisSchema, input)).toEqual({ synthesis: payload });
    });

    test("repairs genuine double encoding", () => {
        const input = { synthesis: JSON.stringify(payload) };

        expect(repairAgainst(SynthesisSchema, input)).toEqual({ synthesis: payload });
    });

    test("repairs an array field wrapped in function-call markup", () => {
        const schema = z.object({ steps: z.array(z.string()) });
        const input = { steps: '["a","b"]</parameter>\n</invoke>' };

        expect(repairAgainst(schema, input)).toEqual({ steps: ["a", "b"] });
    });

    test("leaves a legitimate string field holding JSON-looking text untouched", () => {
        const schema = z.object({ note: z.string(), synthesis: z.object({ runId: z.string() }) });
        const input = { note: '{"not":"a schema object"}', synthesis: '{"runId":"run-1"}</parameter>' };

        const repaired = repairAgainst(schema, input) as { note: string; synthesis: unknown };

        expect(repaired.note).toBe('{"not":"a schema object"}');
        expect(repaired.synthesis).toEqual({ runId: "run-1" });
    });

    test("does not repair when the schema expected a string", () => {
        const schema = z.object({ note: z.string() });

        expect(repairAgainst(schema, { note: 42 })).toBeUndefined();
    });

    test("does not accept a parsed object where the schema expected an array", () => {
        const schema = z.object({ steps: z.array(z.string()) });

        expect(repairAgainst(schema, { steps: '{"a":1}' })).toBeUndefined();
    });

    test("does not accept a parsed array where the schema expected an object", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }) });

        expect(repairAgainst(schema, { synthesis: '["a"]' })).toBeUndefined();
    });

    test("returns undefined for a leading function-call fragment without throwing", () => {
        const input = { synthesis: '\n<parameter name="runId">fb0f43f5-1234' };

        expect(() => repairAgainst(SynthesisSchema, input)).not.toThrow();
        expect(repairAgainst(SynthesisSchema, input)).toBeUndefined();
    });

    test("returns undefined for a truncated JSON payload", () => {
        expect(repairAgainst(SynthesisSchema, { synthesis: '{"runId":"run-1", "findings": [' })).toBeUndefined();
    });

    test("skips strings above the size ceiling", () => {
        const huge = `{"runId":"${"x".repeat(1_000_001)}","findings":[]}`;

        expect(repairAgainst(SynthesisSchema, { synthesis: huge })).toBeUndefined();
    });

    test("does not mutate the original input", () => {
        const raw = `${JSON.stringify(payload)}</parameter>\n</invoke>`;
        const input = { synthesis: raw };
        const snapshot = structuredClone(input);

        const repaired = repairAgainst(SynthesisSchema, input);

        expect(input).toEqual(snapshot);
        expect(input.synthesis).toBe(raw);
        expect(repaired).not.toBe(input);
    });

    test("repairs a nested path and shares the untouched branches", () => {
        const schema = z.object({
            meta: z.object({ id: z.string() }),
            findings: z.array(z.object({ title: z.string(), references: z.array(z.object({ pmid: z.string() })) })),
        });
        const input = {
            meta: { id: "m-1" },
            findings: [
                { title: "kept", references: [{ pmid: "1" }] },
                { title: "wrapped", references: '[{"pmid":"2"}]</parameter>\n</invoke>' },
            ],
        };

        const repaired = repairAgainst(schema, input) as typeof input & { findings: { references: unknown }[] };

        expect(repaired.findings[1]!.references).toEqual([{ pmid: "2" }]);
        expect(schema.safeParse(repaired).success).toBe(true);
        // Untouched branches are shared, not copied.
        expect(repaired.meta).toBe(input.meta);
        expect(repaired.findings[0]).toBe(input.findings[0]);
        expect(input.findings[1]!.references).toBe('[{"pmid":"2"}]</parameter>\n</invoke>');
    });

    test("repairs several wrapped fields in one pass", () => {
        const schema = z.object({ synthesis: z.object({ runId: z.string() }), steps: z.array(z.string()) });
        const input = { synthesis: '{"runId":"run-1"}</parameter>', steps: '["a"]</parameter>\n</invoke>' };

        expect(repairAgainst(schema, input)).toEqual({ synthesis: { runId: "run-1" }, steps: ["a"] });
    });

    test("returns a repaired value that can still fail the schema", () => {
        // The wrapper comes off, the JSON parses, and the result is still wrong:
        // repair makes validation reachable, it does not make it pass.
        const input = { synthesis: '{"runId":42}</parameter>\n</invoke>' };

        const repaired = repairAgainst(SynthesisSchema, input);

        expect(repaired).toEqual({ synthesis: { runId: 42 } });
        expect(SynthesisSchema.safeParse(repaired).success).toBe(false);
    });
});
