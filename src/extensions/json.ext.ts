import type { ZodType } from "zod";

declare global {
    interface JSON {
        // Parses raw JSON and validates it against a zod schema; null on either a
        // parse error or a schema mismatch, so callers can surface the raw
        // payload in their own typed errors. Mirrors JSON.parse's text-first arg
        // order, with the schema in place of a reviver.
        parseWith<T>(raw: string, schema: ZodType<T>): T | null;
    }
}

JSON.parseWith = function <T>(raw: string, schema: ZodType<T>): T | null {
    try {
        const parsed: unknown = JSON.parse(raw); // unknown: external input, validated by the schema below
        const result = schema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
};

export {};
