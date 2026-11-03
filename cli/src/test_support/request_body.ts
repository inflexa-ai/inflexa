import { z } from "zod";

const modelBodySchema = z.looseObject({ model: z.string() });

/** The `model` of the JSON body that a stubbed `fetch` receives. A body that is not JSON with a string `model` fails the test. */
export function requestedModel(init: RequestInit | undefined): string {
    return modelBodySchema.parse(JSON.parse(String(init?.body))).model;
}
