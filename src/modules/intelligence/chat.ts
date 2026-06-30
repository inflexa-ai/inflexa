import { streamText, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type Result, ok, err } from "neverthrow";
import { z } from "zod";

import { Bus } from "../../lib/bus.ts";
import { env } from "../../lib/env.ts";
import { createMessage, updateMessage, createPart, updatePart } from "../../db/primary_mutation.ts";
import { listSessionMessages } from "../../db/primary_query.ts";
import { withTransaction } from "../../db/util.ts";
import type { DbError } from "../../db/errors.ts";
import type { StoredMessage, TextPart } from "../../types/session.ts";

// The intelligence module's model-interaction engine talks to the model through CLIProxyAPI (provisioned by
// `inflexa setup`). The proxy exposes an OpenAI-compatible endpoint that routes to
// whichever provider was authenticated, so the AI SDK's openai-compatible
// provider gives us one code path for Gemini/OpenAI/Claude/Qwen/iFlow — the
// model id picks the upstream. We keep the AI SDK (rather than hand-rolling the
// REST call) because it also brings tool calling / structured output for the
// agentic features to come. The proxy endpoint is the single source of truth in
// env.ts (env.cliproxyApiUrl) — not user-overridable, since we own the container.

const SYSTEM_PROMPT = "You are Inflexa, a concise and helpful coding assistant operating in a terminal.";

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/**
 * Resolved once per process from the proxy's model list (which reflects the
 * authenticated provider). The user primarily uses Anthropic, so prefer a
 * Claude model when present, then other known families, then whatever is first
 * — this keeps the default adapting to whatever `inflexa setup` signed into.
 */
const MODEL_PREFERENCE = ["claude", "gpt", "gemini", "qwen"];
let cachedModelId: string | null = null;

export type ChatOptions = {
    sessionId: string;
    userText: string;
    abort?: AbortSignal;
};

/** Setup failures surfaced before streaming begins — the proxy key is missing, unreachable, or reports no models. */
export type ChatSetupError = { type: "proxy_key_missing" } | { type: "proxy_unreachable"; detail: string } | { type: "no_models" };

export async function chat(opts: ChatOptions): Promise<Result<void, DbError>> {
    const { sessionId, userText, abort } = opts;

    Bus.emit("inflexa", { type: "session.status", sessionId, status: "busy" });

    // Persist the user turn first so the history we build below includes it. The message and
    // its part commit together — a failure mid-way must not leave a message with no content.
    // Events fire only after the commit, so the UI never sees a turn that was rolled back.
    const userTurn = withTransaction("chat:userTurn", () =>
        createMessage(sessionId, "user").andThen((userMsg) => createPart(sessionId, userMsg.id, userText).map((userPart) => ({ userMsg, userPart }))),
    ).match(
        ({ userMsg, userPart }) => {
            Bus.emit("inflexa", { type: "message.created", message: userMsg });
            Bus.emit("inflexa", { type: "part.updated", part: userPart });
            return { ok: true as const };
        },
        (error) => ({ ok: false as const, error }),
    );
    if (!userTurn.ok) {
        Bus.emit("inflexa", { type: "session.status", sessionId, status: "error" });
        return err(userTurn.error);
    }

    // Build the model history from the persisted conversation (the assistant
    // turn isn't created yet, so it isn't included).
    const history = listSessionMessages(sessionId).match(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
    );
    if (!history.ok) {
        Bus.emit("inflexa", { type: "session.status", sessionId, status: "error" });
        return err(history.error);
    }
    const modelMessages = toModelMessages(history.value);

    // Create the assistant message + an empty part to stream into — atomically, so a partial
    // turn can't survive a failure. The created event fires only once both rows are committed.
    const assistantTurn = withTransaction("chat:assistantTurn", () =>
        createMessage(sessionId, "assistant").andThen((assistantMsg) =>
            createPart(sessionId, assistantMsg.id, "").map((assistantPart) => ({ assistantMsg, assistantPart })),
        ),
    ).match(
        (val) => {
            Bus.emit("inflexa", { type: "message.created", message: val.assistantMsg });
            // Broadcast the empty part now (symmetric with the user part above) so it lands in the
            // store before deltas flow. Without it the assistant message renders with no parts, the
            // streaming text binds to nothing, and tokens only appear at turn end (see the post-stream
            // part.updated below) — the live typing effect needs the part mounted up front.
            Bus.emit("inflexa", { type: "part.updated", part: val.assistantPart });
            return { ok: true as const, ...val };
        },
        (error) => ({ ok: false as const, error }),
    );
    if (!assistantTurn.ok) {
        Bus.emit("inflexa", { type: "session.status", sessionId, status: "error" });
        return err(assistantTurn.error);
    }
    const { assistantMsg, assistantPart } = assistantTurn;

    // Stream the response. Model/network failures surface via session.error;
    // a user abort just stops and keeps whatever was streamed so far.
    let accumulated = "";
    // Captures a streaming failure. The AI SDK does NOT throw model/API errors into the
    // `textStream` consumer — it ends the stream and hands the error to `onError`. So a model
    // error (e.g. the proxy advertising a model id the upstream then 404s) otherwise produces a
    // SILENT empty assistant turn: the loop exits with no text and no exception, status goes idle,
    // and the user sees a blank reply with no clue why. Capture it and surface it below, the same
    // as a thrown setup failure.
    let streamError: unknown;
    const apiKey = (await readApiKey()).match(
        (k) => k,
        (e) => {
            streamError = e;
            return null;
        },
    );
    const modelId = apiKey
        ? (await resolveModelId(apiKey)).match(
              (m) => m,
              (e) => {
                  streamError = e;
                  return null;
              },
          )
        : null;
    if (apiKey && modelId) {
        try {
            const provider = createOpenAICompatible({ name: "cliproxy", baseURL: env.cliproxyApiUrl, apiKey });
            const result = streamText({
                model: provider(modelId),
                system: SYSTEM_PROMPT,
                messages: modelMessages,
                abortSignal: abort,
                // Anthropic requires an explicit max_tokens; the proxy passes the
                // OpenAI-format value through when translating to Claude, so set a
                // generous cap to make Claude work out of the box.
                maxOutputTokens: 8192,
                onError: ({ error }) => {
                    streamError = error;
                },
            });
            for await (const delta of result.textStream) {
                accumulated += delta;
                Bus.emit("inflexa", { type: "part.delta", sessionId, messageId: assistantMsg.id, partId: assistantPart.id, delta });
            }
        } catch (error) {
            // Streaming failures from the AI SDK that surface as exceptions (not via onError).
            streamError = error;
        }
    }
    // A user abort is not an error — it just stops and keeps whatever streamed so far.
    if (streamError && !abort?.aborted) {
        Bus.emit("inflexa", { type: "session.error", sessionId, error: `Model error: ${describe(streamError)}` });
    }

    // Persist the final assistant text (possibly partial on abort/error) and stamp the turn's
    // wall-clock duration on the message, then return to idle so the UI flushes the streamed text.
    // Duration is measured from the assistant message's creation (just before stream setup) to now,
    // so it captures the whole perceived wait — model setup plus generation. Part text and message
    // duration commit in one transaction so a half-written turn (text without duration) can't persist.
    (assistantPart as TextPart).text = accumulated;
    assistantMsg.durationMs = Date.now() - assistantMsg.createdAt;
    return withTransaction("chat:finalizeAssistant", () => updatePart(assistantPart).andThen(() => updateMessage(assistantMsg))).match(
        () => {
            Bus.emit("inflexa", { type: "part.updated", part: assistantPart });
            Bus.emit("inflexa", { type: "message.updated", message: assistantMsg });
            Bus.emit("inflexa", { type: "session.status", sessionId, status: "idle" });
            return ok<void, DbError>(undefined);
        },
        (error) => {
            Bus.emit("inflexa", { type: "session.status", sessionId, status: "error" });
            return err<void, DbError>(error);
        },
    );
}

/**
 * Flatten persisted messages into the AI SDK's `ModelMessage[]`: text parts only, joined per
 * message; a message whose text is empty (e.g. an interrupted assistant placeholder) is dropped.
 */
export function toModelMessages(stored: StoredMessage[]): ModelMessage[] {
    const messages: ModelMessage[] = [];
    for (const m of stored) {
        const content = m.parts
            .filter((p): p is TextPart => p.type === "text")
            .map((p) => p.text)
            .join("");
        // Skip empties (e.g. a freshly created assistant placeholder from a
        // prior, interrupted turn).
        if (content) messages.push({ role: m.info.role, content });
    }
    return messages;
}

/** The proxy requires the client API key we generated into its config at setup. */
async function readApiKey(): Promise<Result<string, ChatSetupError>> {
    const text = await Bun.file(env.cliproxyConfigPath)
        .text()
        .catch(() => "");
    const key = text.match(/^api-keys:\s*\n\s*-\s*"([^"]+)"/m)?.[1];
    if (!key) return err({ type: "proxy_key_missing" });
    return ok(key);
}

async function resolveModelId(apiKey: string): Promise<Result<string, ChatSetupError>> {
    if (cachedModelId) return ok(cachedModelId);
    let res: Response;
    try {
        res = await fetch(`${env.cliproxyApiUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (cause) {
        return err({ type: "proxy_unreachable", detail: cause instanceof Error ? cause.message : String(cause) });
    }
    if (!res.ok) return err({ type: "proxy_unreachable", detail: `HTTP ${res.status}` });
    const models = await res.jsonWith(modelsSchema);
    if (!models || models.data.length === 0) return err({ type: "no_models" });
    cachedModelId = pickDefaultModel(models.data.map((m) => m.id));
    return ok(cachedModelId);
}

/**
 * Pick the default model id by {@link MODEL_PREFERENCE} (claude > gpt > gemini > qwen, matched
 * case-insensitively by substring), falling back to the first id when no family matches.
 */
export function pickDefaultModel(ids: string[]): string {
    for (const family of MODEL_PREFERENCE) {
        const match = ids.find((id) => id.toLowerCase().includes(family));
        if (match) return match;
    }
    return ids[0]!;
}

function describe(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    if (typeof cause === "object" && cause !== null && "type" in cause) {
        // ChatSetupError carries a discriminated `type` — map it to actionable guidance.
        const typed = cause as ChatSetupError;
        switch (typed.type) {
            case "proxy_key_missing":
                return "could not read the proxy API key — run `inflexa setup`";
            case "proxy_unreachable":
                return `the proxy returned ${typed.detail} listing models`;
            case "no_models":
                return "the proxy reported no models — is a provider authenticated? run `inflexa setup`";
            default:
                return (cause as { type: string }).type;
        }
    }
    return String(cause);
}
