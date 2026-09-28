import type { AskPart } from "@inflexa-ai/harness/contracts/chat-parts.js";
import type { MessagePart, TextPart, ToolCallPart } from "@inflexa-ai/harness/contracts/message.js";

/**
 * A harness text part as the store holds it. `key` is set only on a part that the live turn makes: it is what
 * `streamPartId` names while the stream writes into the part. A reloaded part carries none, because nothing
 * streams into it.
 */
export type LiveTextPart = TextPart & {
    /** The store key of the part that the live stream writes into. */
    key?: string;
};

/** A harness tool-call part, with the activity line of the sub-agent that works inside the running call. */
export type LiveToolCallPart = ToolCallPart & {
    /**
     * What the innermost sub-agent working inside this call is doing right now, or absent.
     *
     * Live-only and never persisted: it is a description of work in flight, meaningless once the call
     * has an outcome, so it is cleared when the call finishes. A sub-agent's own iterations and tool
     * calls are far too numerous to enter the transcript as blocks — this one line is what makes a
     * long tool call legible instead of indistinguishable from a wedged one.
     */
    activity?: string;
};

/** A harness ask part, with the reject feedback that the user typed on the live surface. */
export type LiveAskPart = AskPart & {
    /**
     * The reject feedback the user typed, echoed by the answering surface at answer time — the ledger
     * and the model-facing denial carry it independently; this field is presentation only. Only ever set
     * alongside a `rejected` status, and never reconstructed on reload (the card is a live-turn visual).
     */
    feedback?: string;
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
 * One step of a drafted plan card, as `readPlanCard` reads it off the harness `data-plan` part. Primitive
 * fields only, copied at the read, thus the view holds no harness object.
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

/**
 * The text-shaped body of an inline `show_user` presentation, rendered through the `<markdown>`
 * renderable. Primitive fields only (strings and string arrays), extracted at the read so the view
 * holds no harness object. `echart`/`svg` are pixel-shaped and become {@link OpenableEntry} rows
 * instead, so they are absent from this union.
 */
export type PresentationBody =
    | { kind: "markdown"; body: string }
    | { kind: "code"; code: string; language: string }
    | { kind: "table"; headers: string[]; rows: string[][]; caption?: string };

/**
 * How an openable card entry resolves to something to open — the SEMANTIC reference, never a resolved
 * location (the artifact-open spec's open-time-resolution rule). Resolution happens when the user opens:
 * `workspace-file` joins the analysis workspace root; `echart`/`svg` materialize a file under the
 * workspace's `presentations/` directory from the embedded spec/markup; `unavailable` is a card with
 * nothing to open.
 */
export type OpenTarget =
    | { kind: "workspace-file"; path: string }
    | { kind: "echart"; presId: string; spec: Record<string, unknown>; dataPath?: string }
    | { kind: "svg"; presId: string; markup: string }
    | { kind: "unavailable"; reason: string };

/**
 * One row of an openable card: its name, optional caption, and the reference resolved at open time.
 * An entry carries no content-kind marker — the card's gutter marks only whether a row opens or is
 * broken, and the name plus its file extension already tell a reader what kind of thing it is.
 */
export type OpenableEntry = {
    /** Row name (file basename, chart title, "Report vN"). */
    name: string;
    /** Optional one-line context beside the name. */
    caption?: string;
    /** The semantic reference this row opens. */
    target: OpenTarget;
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
 * A message part as the TUI store holds it: a harness part, discriminated on `type`. The live turn and a
 * reload give the same harness parts. Three of them can carry screen state of the live turn: the key of a
 * streaming text part, the activity line of a running tool call, and the reject feedback of an ask.
 * `thinking` and `file-edit` remain MOCK (fixture-driven), so the gallery can render every design-system
 * state.
 */
export type Part = LiveTextPart | LiveToolCallPart | LiveAskPart | Exclude<MessagePart, TextPart | ToolCallPart | AskPart> | ThinkingPart | FileEditPart;
