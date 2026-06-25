export type Session = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
};

export type Message = {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    createdAt: number;
    /** Wall-clock duration of the turn, ms. Assistant turns only — stamped when the stream finishes; absent on user turns and on an assistant turn not yet completed. */
    durationMs?: number;
};

/** A plain text part — the only kind the live engine produces and the only kind persisted. */
export type TextPart = {
    id: string;
    sessionId: string;
    messageId: string;
    type: "text";
    text: string;
    createdAt: number;
};

/**
 * MOCK part: a reasoning/thinking block. Not produced by the live engine and not
 * persisted — exists so the stream can render the "thinking" state from fixtures.
 * Wiring real reasoning emission is a deliberate follow-up.
 */
export type ThinkingPart = {
    id: string;
    sessionId: string;
    messageId: string;
    type: "thinking";
    /** The reasoning body, collapsed by default in the block. */
    text: string;
    /** Optional elapsed reasoning time, milliseconds. */
    durationMs?: number;
    createdAt: number;
};

/**
 * MOCK part: a tool/verb invocation and its result. Not produced by the live
 * engine and not persisted — drives the "tool call" stream state from fixtures.
 */
export type ToolCallPart = {
    id: string;
    sessionId: string;
    messageId: string;
    type: "tool-call";
    /** Tool/verb name, e.g. `read_file`. */
    name: string;
    /** What the tool acted on, e.g. a file path with a line range. */
    target: string;
    /** The tool's textual result/output, rendered in a `<code>` block. */
    result: string;
    /** Source filetype for syntax highlighting of `result` (e.g. `ts`). */
    filetype: string;
    /** Lifecycle of the call. */
    status: "running" | "ok" | "error";
    createdAt: number;
};

/**
 * MOCK part: a file edit. Not produced by the live engine and not persisted —
 * drives the "diff / file edit" stream state from fixtures.
 */
export type FileEditPart = {
    id: string;
    sessionId: string;
    messageId: string;
    type: "file-edit";
    /** Edited file path. */
    path: string;
    /** A unified-diff string, rendered by the `<diff>` renderable. */
    diff: string;
    /** Lines added. */
    added: number;
    /** Lines removed. */
    removed: number;
    createdAt: number;
};

/**
 * A message part. `TextPart` is the only kind the live engine produces or
 * persists; the remaining kinds are MOCK (fixture-driven) so the stream can
 * render every design-system state. Discriminated on `type`.
 */
export type Part = TextPart | ThinkingPart | ToolCallPart | FileEditPart;

export type StoredMessage = {
    info: Message;
    parts: Part[];
};
