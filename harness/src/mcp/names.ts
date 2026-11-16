import { createHash } from "node:crypto";

/** The longest tool name that each supported provider accepts. */
export const MAX_TOOL_NAME_LENGTH = 64;

const HASH_LENGTH = 8;

function shortHash(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
}

/** Each character outside `[a-zA-Z0-9_-]` becomes `_`, because a provider refuses a tool name with any other character. */
function sanitize(text: string): string {
    let out = "";
    for (const char of text) {
        const allowed = (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || (char >= "0" && char <= "9") || char === "_" || char === "-";
        out += allowed ? char : "_";
    }
    return out;
}

/**
 * The names of the tools of one MCP server, as an agent sees them: `mcp__<server>__<tool>`. A name past the limit is
 * cut and ends with a short hash of the full name. Two tools that give one name each get a hash suffix, thus each
 * name stays unique.
 */
export function mcpToolNames(server: string, tools: readonly string[]): ReadonlyMap<string, string> {
    const candidates = tools.map((tool) => {
        const full = `mcp__${sanitize(server)}__${sanitize(tool)}`;
        const name =
            full.length <= MAX_TOOL_NAME_LENGTH ? full : `${full.slice(0, MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1)}_${shortHash(`${server}\u0000${tool}`)}`;
        return { tool, name };
    });
    const counts = new Map<string, number>();
    for (const { name } of candidates) counts.set(name, (counts.get(name) ?? 0) + 1);
    const names = new Map<string, string>();
    for (const { tool, name } of candidates) {
        if ((counts.get(name) ?? 0) === 1) {
            names.set(tool, name);
            continue;
        }
        const suffix = `_${shortHash(`${server}\u0000${tool}`)}`;
        names.set(tool, `${name.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`);
    }
    return names;
}
