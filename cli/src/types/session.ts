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
export type PlanCardStepView = {
    id: string;
    name: string;
    agent: string;
    question: string;
    acceptance_criteria: string[];
    constraints: string[];
    caveats: string[];
    depends_on: string[];
    resources: { cpu: number; memoryGb: number; gpuCount: number } | null;
    track: string;
    step_type: string;
};

export type PlanCardPart = {
    id: string;
    type: "plan-card";
    /** The stored plan's id. */
    planId: string;
    /** Plan title (empty when the harness card carried none). */
    title: string;
    /** Ordered plan steps, copied into the CLI-owned primitive view at receipt. */
    steps: PlanCardStepView[];
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
 * The text-shaped body of an inline `show_user` presentation, rendered through the `<markdown>`
 * renderable. Primitive fields only (strings and string arrays), extracted at receipt so nothing
 * mutable from the in-process emit stream reaches the store. `echart`/`svg` are pixel-shaped and
 * become {@link OpenableCardPart}s instead, so they are absent from this union.
 */
export type PresentationBody =
    | { kind: "markdown"; body: string }
    | { kind: "code"; code: string; language: string }
    | { kind: "table"; headers: string[]; rows: string[][]; caption?: string };

/**
 * Agent-synthesized text-shaped content the conversation agent presented via `show_user`
 * (`markdown`/`code`/`table`). Renders inline through the `<markdown>` renderable — no open step.
 * Carries only the primitive body extracted at receipt (copy-on-receive), never a harness object.
 */
export type PresentationPart = {
    id: string;
    type: "presentation";
    /** Optional heading shown above the content. */
    title?: string;
    /** The text-shaped body to render. */
    body: PresentationBody;
};

/** The glyph shape a card entry's row shows in the gutter — chosen by content kind, mapped to `GLYPHS` by the block. */
export type OpenableIcon = "chart" | "image" | "document" | "report";

/**
 * How an openable card entry resolves to something to open — the SEMANTIC reference, never a resolved
 * location (the artifact-open spec's open-time-resolution rule). Resolution happens when the user opens:
 * `workspace-file` joins the analysis workspace root; `echart`/`svg` materialize a file under the
 * workspace's `presentations/` directory from the embedded spec/markup; `unavailable` is a card with
 * nothing to open (a failed report preview).
 */
export type OpenTarget =
    | { kind: "workspace-file"; path: string }
    | { kind: "echart"; presId: string; spec: Record<string, unknown>; dataPath?: string }
    | { kind: "svg"; presId: string; markup: string }
    | { kind: "unavailable"; reason: string };

/** One row of an openable card: its glyph, name, optional caption, and the reference resolved at open time. */
export type OpenableEntry = {
    /** Glyph shape for the row marker. */
    icon: OpenableIcon;
    /** Row name (file basename, chart title, "Report vN"). */
    name: string;
    /** Optional one-line context beside the name. */
    caption?: string;
    /** The semantic reference this row opens. */
    target: OpenTarget;
};

/**
 * Pixel-shaped content a terminal cannot paint — `echart`/`svg` presentations, `show_file` galleries,
 * and report previews — rendered as a card whose rows open externally. Carries only the semantic
 * reference fields extracted at receipt (copy-on-receive); `analysisId` scopes resolution of every
 * entry's `workspace-file`/`dataPath` reference against the analysis workspace root at open time.
 */
export type OpenableCardPart = {
    id: string;
    type: "openable-card";
    /** The analysis whose workspace root resolves this card's entries at open time. */
    analysisId: string;
    /** Optional card heading. */
    title?: string;
    /** One row per openable item (a multi-file gallery has several). */
    entries: OpenableEntry[];
    /** Analysis-rooted containing folder for a multi-file gallery (the reveal-folder affordance); absent otherwise. */
    folderPath?: string;
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
 * `plan-card`, `run-card`, `presentation`, and `openable-card` are produced live by
 * the harness emit adapter (and reconstructed on transcript reload); `thinking`/
 * `file-edit` remain MOCK (fixture-driven) so the gallery can render every
 * design-system state. Discriminated on `type`.
 */
export type Part = TextPart | ThinkingPart | ToolCallPart | FileEditPart | PlanCardPart | RunCardPart | PresentationPart | OpenableCardPart;

export type StoredMessage = {
    info: Message;
    parts: Part[];
};
