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
 * A tool/verb invocation and its outcome. The harness emit adapter mints this
 * from live `tool-started`/`tool-finished` events (name + status + duration);
 * the fixture-driven gallery also fills `target`/`result`/`filetype` to show the
 * richer result panel. Those three are OPTIONAL because live harness tool events
 * carry no target/result/filetype — only the name, outcome, and timing.
 */
export type ToolCallPart = {
    id: string;
    sessionId: string;
    messageId: string;
    type: "tool-call";
    /** Tool/verb name, e.g. `read_file`. */
    name: string;
    /** What the tool acted on, e.g. a file path with a line range. Absent for live harness tool events. */
    target?: string;
    /** The tool's textual result/output, rendered in a `<code>` block. Absent for live harness tool events. */
    result?: string;
    /** Source filetype for syntax highlighting of `result` (e.g. `ts`). Absent for live harness tool events. */
    filetype?: string;
    /** Lifecycle of the call — `running` on start, `ok`/`error` on finish. */
    status: "running" | "ok" | "error";
    /** Wall-clock duration in ms, stamped when the call finishes; absent while running. */
    durationMs?: number;
    createdAt: number;
};

/**
 * A drafted analysis plan the conversation agent presented. Carries ONLY the
 * primitive fields the harness `readPlanCard` reader extracts — never a harness
 * object — so nothing mutable from the in-process emit stream reaches the store.
 */
export type PlanCardPart = {
    id: string;
    type: "plan-card";
    /** The stored plan's id. */
    planId: string;
    /** Plan title (empty when the harness card carried none). */
    title: string;
    /** Ordered plan steps, each a flat primitive triple. */
    steps: { id: string; name: string; agent: string }[];
};

/**
 * A launched run the conversation agent started from an approved plan. Primitive
 * fields only (via `readRunCard`). The harness run-card contract carries no live
 * run-status field, so this holds identity + step count only.
 */
export type RunCardPart = {
    id: string;
    type: "run-card";
    /** The launched run's id (stamped with the chat thread id in `cortex_runs`). */
    runId: string;
    /** Run title (empty when the harness card carried none). */
    title: string;
    /** How many steps the launched plan holds. */
    stepCount: number;
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
 * A message part. `TextPart` is the only kind persisted to SQLite; `tool-call`,
 * `plan-card`, and `run-card` are produced live by the harness emit adapter (and
 * reconstructed on transcript reload); `thinking`/`file-edit` remain MOCK
 * (fixture-driven) so the gallery can render every design-system state.
 * Discriminated on `type`.
 */
export type Part = TextPart | ThinkingPart | ToolCallPart | FileEditPart | PlanCardPart | RunCardPart;

export type StoredMessage = {
    info: Message;
    parts: Part[];
};
