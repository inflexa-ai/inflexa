/**
 * Canonical JSON (RFC 8785, JCS) and the content digests built on it.
 *
 * JCS serializes an object with its keys sorted by UTF-16 code units, no
 * whitespace, and the ES number formatting that `JSON.stringify` already
 * gives. Thus the same record gives the same bytes on any machine, and a
 * digest over those bytes is a stable identity for a claim and for a snapshot.
 */

export function canonicalize(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(text);
    return hasher.digest("hex");
}

/** The digest of the canonical form, as `sha256:<hex>`. */
export function contentDigest(value: unknown): string {
    return `sha256:${sha256Hex(canonicalize(value))}`;
}

/**
 * The claim identifier of a rule: the rule id plus the first four hex digits
 * of its content hash, for example `R-0031@e7d0`. A rule edit changes the
 * suffix, thus a plan that pinned the old claim no longer matches the new one.
 */
export function claimId(ruleId: string, digest: string): string {
    const hex = digest.replace(/^sha256:/, "");
    return `${ruleId}@${hex.slice(0, 4)}`;
}
