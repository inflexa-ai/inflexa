import { z } from "zod";

function parseJsonText(text: string): unknown {
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the one JSON.parse of the tree: every caller states the schema its boundary assumes.
    return JSON.parse(text);
}

/** Parse `text` and validate it with `schema`: malformed text throws the parse's `SyntaxError`, a schema failure throws the `ZodError`. */
export function parseJsonAs<T>(text: string, schema: z.ZodType<T>): T {
    return schema.parse(parseJsonText(text));
}

/** Parse `text`, validate it with `schema`, and give the zod result. A malformed text still throws the parse's `SyntaxError`; only the schema outcome is a result. */
export function safeParseJsonAs<T>(text: string, schema: z.ZodType<T>): z.ZodSafeParseResult<T> {
    return schema.safeParse(parseJsonText(text));
}
