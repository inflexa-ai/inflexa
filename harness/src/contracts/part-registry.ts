import type { ChatPart } from "./chat-parts.js";

export type ChatPartType = ChatPart["type"];

export type PartEmitter = "workflow" | "conversation";
export type PartConsumer = "sidebar" | "conversation";

export interface PartDescriptor {
    /** Which layer emits this part. */
    emitter: PartEmitter;
    /** Which UI surface consumes this part. */
    consumer: PartConsumer;
    /** If true, only useful during live streaming — not accumulated in workflow state. */
    transient: boolean;
    /** If true, multiple emissions share the same id — latest wins. */
    reconciling: boolean;
}

export const PART_REGISTRY: Record<ChatPartType, PartDescriptor> = {
    "data-presentation": { emitter: "conversation", consumer: "conversation", transient: false, reconciling: false },
    "data-plan": { emitter: "conversation", consumer: "conversation", transient: false, reconciling: false },
    "data-run-card": { emitter: "conversation", consumer: "conversation", transient: false, reconciling: false },
    "data-file-reference": { emitter: "conversation", consumer: "conversation", transient: false, reconciling: false },
    "data-ask": { emitter: "conversation", consumer: "conversation", transient: false, reconciling: true },
    "data-run-started": { emitter: "workflow", consumer: "sidebar", transient: true, reconciling: false },
    "data-dag-state": { emitter: "workflow", consumer: "sidebar", transient: false, reconciling: true },
    "data-step-activity": { emitter: "workflow", consumer: "sidebar", transient: true, reconciling: true },
    "data-step-file-tree": { emitter: "workflow", consumer: "sidebar", transient: true, reconciling: true },
    "data-step-output": { emitter: "workflow", consumer: "sidebar", transient: false, reconciling: false },
    "data-step-summary": { emitter: "workflow", consumer: "sidebar", transient: false, reconciling: false },
    "data-step-usage": { emitter: "workflow", consumer: "sidebar", transient: false, reconciling: false },
    "data-step-blocked": { emitter: "workflow", consumer: "sidebar", transient: false, reconciling: false },
    "data-run-synthesis": { emitter: "workflow", consumer: "sidebar", transient: false, reconciling: false },
    "data-synthesis-progress": { emitter: "workflow", consumer: "sidebar", transient: false, reconciling: true },
    "data-run-completed": { emitter: "workflow", consumer: "sidebar", transient: false, reconciling: false },
    "data-run-failed": { emitter: "workflow", consumer: "sidebar", transient: false, reconciling: false },
    "data-child-session-started": { emitter: "conversation", consumer: "conversation", transient: false, reconciling: false },
    "data-report-rendered": { emitter: "conversation", consumer: "conversation", transient: false, reconciling: false },
    "data-compaction": { emitter: "conversation", consumer: "conversation", transient: true, reconciling: true },
};

export function isTransient(type: ChatPartType): boolean {
    return PART_REGISTRY[type].transient;
}

export function isReconciling(type: ChatPartType): boolean {
    return PART_REGISTRY[type].reconciling;
}

export function isSidebarPart(type: ChatPartType): boolean {
    return PART_REGISTRY[type].consumer === "sidebar";
}
