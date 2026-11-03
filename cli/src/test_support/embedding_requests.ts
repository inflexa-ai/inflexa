import { z } from "zod";

/** The body that a test llama server reads from `POST /tokenize`. */
export const tokenizeRequestSchema = z.object({ content: z.string() });

/** The body that a test llama server reads from `POST /v1/embeddings`. */
export const embeddingsRequestSchema = z.object({ input: z.array(z.string()) });
