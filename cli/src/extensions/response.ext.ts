import type { ZodType } from "zod";

declare global {
    interface Response {
        /**
         * Reads the response body as JSON and validates it against a zod schema;
         * null on a body-read/parse error or a schema mismatch, so callers can
         * surface the failure in their own typed error. The Response analog of
         * JSON.parseWith. Consumes the body (a Response is read-once), so use it
         * only where the raw text isn't also needed for diagnostics or a second
         * parse — read the body as text and use JSON.parseWith in that case.
         */
        jsonWith<T>(schema: ZodType<T>): Promise<T | null>;
    }
}

Response.prototype.jsonWith = async function <T>(this: Response, schema: ZodType<T>): Promise<T | null> {
    try {
        const parsed: unknown = await this.json(); // unknown: external response body, validated by the schema below
        const result = schema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
};

export {};
