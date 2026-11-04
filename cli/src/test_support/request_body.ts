import { z } from "zod";

import { parsedJson } from "./json.ts";

const modelBodySchema = z.looseObject({ model: z.string() });

/**
 * The text of the body that a stubbed `fetch` receives. A string body gives itself, and a `URLSearchParams`
 * body gives its form encoding. A missing body, or a body of another form, throws, because a double that
 * reads text must not read `"undefined"` or `"[object Blob]"` as if it were the body.
 */
export function requestBodyText(init: RequestInit | undefined): string {
    const body = init?.body;
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    throw new Error(body === undefined || body === null ? "the request has no body" : "the request body is neither a string nor a URLSearchParams");
}

/** The `model` of the JSON body that a stubbed `fetch` receives. A body that is not JSON with a string `model` fails the test. */
export function requestedModel(init: RequestInit | undefined): string {
    return parsedJson(requestBodyText(init), modelBodySchema).model;
}
