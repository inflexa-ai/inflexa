/**
 * Execution ID generation — ported from shared/lib/execution-id.ts.
 *
 * Produces a single ID that embeds the agent name, used everywhere:
 * sandbox pod name, K8s Job name, audit log files.
 *
 * Format: {sanitizedAgentName}-{nanoid8}  (e.g., qc-agent-a1b2c3d4)
 */

import { customAlphabet } from "nanoid";

/** Length of the nanoid suffix (8 characters). */
export const EXECUTION_ID_NANOID_LENGTH = 8;

/** Maximum length for the sanitized agent name portion. */
export const AGENT_NAME_MAX_LENGTH = 40;

/**
 * Lowercase alphanumeric alphabet for nanoid suffix.
 * Ensures IDs are valid RFC 1123 DNS labels (required by K8s Job names).
 */
const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789");

/**
 * Sanitize an agent name for use in K8s pod/job names.
 *
 * Rules:
 * - Lowercase only
 * - Only `[a-z0-9-]` characters allowed
 * - Leading/trailing hyphens stripped
 * - Consecutive hyphens collapsed
 * - Truncated to 40 characters
 */
function isAgentNameChar(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-";
}

export function sanitizeAgentName(name: string): string {
    const lowered = name.toLowerCase();
    let mapped = "";
    for (let i = 0; i < lowered.length; i++) mapped += isAgentNameChar(lowered[i]) ? lowered[i] : "-";
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the hyphen-run collapse: a run of 2+ becomes one hyphen, a run rewrite no string method does in one call.
    let stripped = mapped.replace(/-{2,}/g, "-");
    while (stripped.startsWith("-")) stripped = stripped.slice(1);
    while (stripped.endsWith("-")) stripped = stripped.slice(0, -1);
    return stripped.slice(0, AGENT_NAME_MAX_LENGTH);
}

/**
 * Generate a unified execution ID for an agent invocation.
 *
 * @param agentName - The agent name from the registry
 * @returns An ID in the format `{sanitizedAgentName}-{nanoid8}`
 */
export function generateExecutionId(agentName: string): string {
    const sanitized = sanitizeAgentName(agentName);
    const suffix = nanoid(EXECUTION_ID_NANOID_LENGTH);
    return `${sanitized}-${suffix}`;
}
