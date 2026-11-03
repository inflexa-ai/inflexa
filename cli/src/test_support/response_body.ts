import { apiErrorSchema, type ApiError } from "../api/common.ts";

/**
 * The JSON body of `response`, typed `unknown`. bun-types types `Response.json()` as `Promise<any>`,
 * which lets a test read any field with no check. A test asserts the whole value with `toEqual`, one
 * field with `toHaveProperty`, or parses a small schema when it computes on the body.
 */
export async function jsonBody(response: Response | Promise<Response>): Promise<unknown> {
    const body: unknown = await (await response).json();
    return body;
}

/**
 * The error body of `response`, parsed with the schema that the client uses ({@link apiErrorSchema}). A
 * body that is not an {@link ApiError} fails the test with the zod error, and a key beyond the schema
 * stays on the value.
 */
export async function errorBody(response: Response | Promise<Response>): Promise<ApiError> {
    return apiErrorSchema.parse(await jsonBody(response));
}
