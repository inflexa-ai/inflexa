import { DBOS } from "@dbos-inc/dbos-sdk";
import { createHash } from "node:crypto";

const TOOL_ID = "execute_analysis";

function digest(...parts: string[]): Buffer {
    return createHash("sha256")
        .update([TOOL_ID, ...parts].join("\0"), "utf8")
        .digest();
}

/** Deterministic internal plan id in the existing persistence shape. */
export function adHocPlanId(analysisId: string, invocationId: string): string {
    return `pln-${digest(analysisId, invocationId).toString("hex", 0, 4)}`;
}

/** Deterministic RFC-4122 UUID used as both cortex run id and DBOS workflow id. */
export function adHocRunId(analysisId: string, invocationId: string): string {
    return uuidOf(digest(analysisId, invocationId));
}

/**
 * The run id of a plan launch from a tool call, a version-5 UUID of the key of the call. The same call
 * gives the same id, thus a rerun of the call reserves and launches the run of its first attempt.
 */
export function callRunId(callKey: string): string {
    return uuidOf(digest("plan", callKey));
}

/** The key of a tool call inside a workflow, `${workflowId}:${toolCallId}`, or `undefined` outside one, where nothing reruns. */
export function durableCallKey(toolCallId: string): string | undefined {
    const workflowId = DBOS.workflowID;
    return workflowId === undefined ? undefined : `${workflowId}:${toolCallId}`;
}

function uuidOf(hash: Buffer): string {
    const bytes = Buffer.from(hash.subarray(4, 20));
    const versionByte = bytes[6];
    if (versionByte === undefined) throw new Error("the digest is shorter than the UUID layout");
    bytes[6] = (versionByte & 0x0f) | 0x50;
    const variantByte = bytes[8];
    if (variantByte === undefined) throw new Error("the digest is shorter than the UUID layout");
    bytes[8] = (variantByte & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
