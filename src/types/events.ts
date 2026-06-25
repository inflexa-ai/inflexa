import type { Message, Part } from "./session.ts";

/**
 * The cross-process event contract: the intelligence module's chat engine emits
 * these and the TUI consumes them through the bus. Carries session-domain shapes,
 * so it lives in the shared type layer rather than inside the intelligence module.
 */
export type BusEvent =
    | { type: "session.status"; sessionId: string; status: "idle" | "busy" | "error" }
    | { type: "message.created"; message: Message }
    | { type: "message.updated"; message: Message }
    | { type: "part.updated"; part: Part }
    | { type: "part.delta"; sessionId: string; messageId: string; partId: string; delta: string }
    | { type: "session.error"; sessionId: string; error: string };

/** A {@link BusEvent} stamped with a unique id by the bus on emit (for telemetry correlation). */
export type StampedEvent = BusEvent & { __infId: string };
