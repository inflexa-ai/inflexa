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
export function sanitizeAgentName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, AGENT_NAME_MAX_LENGTH);
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
