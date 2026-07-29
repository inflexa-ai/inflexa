import { createHash } from "node:crypto";

const TOOL_ID = "execute_analysis";

function digest(analysisId: string, invocationId: string): Buffer {
    return createHash("sha256").update(`${TOOL_ID}\0${analysisId}\0${invocationId}`, "utf8").digest();
}

/** Deterministic internal plan id in the existing persistence shape. */
export function adHocPlanId(analysisId: string, invocationId: string): string {
    return `pln-${digest(analysisId, invocationId).toString("hex", 0, 4)}`;
}

/** Deterministic RFC-4122 UUID used as both cortex run id and DBOS workflow id. */
export function adHocRunId(analysisId: string, invocationId: string): string {
    const bytes = Buffer.from(digest(analysisId, invocationId).subarray(4, 20));
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
