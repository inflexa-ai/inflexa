/**
 * Input sanitization — pure, always-on text functions, not a plug-in pipeline.
 * What runs is exactly what is declared here.
 *
 * `normalizeUnicode` and `redactSecrets` are applied once to the incoming user
 * message by the chat route (change 6), and never to assistant messages or tool
 * results. `stripNulCharacters` is the exception — it applies to tool results.
 */

/**
 * C0/C1 control characters and DEL, excluding `\t` (U+0009) and `\n`
 * (U+000A) which are legitimate whitespace in user prose.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the intent: this pattern strips invisible C0/C1 bytes and DEL from untrusted user input (see `normalizeUnicode` below).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * NFC-normalize and strip control characters.
 *
 * Unicode normalization collapses visually-identical decomposed sequences
 * to a canonical form; control-char stripping removes invisible C0/C1 bytes
 * that could smuggle formatting or terminal escapes.
 */
export function normalizeUnicode(text: string): string {
    return text.normalize("NFC").replace(CONTROL_CHARS, "");
}

/**
 * NUL (U+0000) — the one character a stored message cannot carry. Postgres
 * refuses it inside JSON: a `jsonb` column rejects the insert outright, and a
 * `json` column accepts it but errors the moment a JSON operator reads that row
 * ("U+0000 cannot be converted to text"), which is what `retractLastTurn`'s
 * boundary predicate does. Either way one NUL byte poisons a thread, and it
 * arrives through no fault of the model: tool results carry raw command output
 * and file bytes, which is why they are otherwise left unsanitized.
 */
// eslint-disable-next-line no-control-regex -- matching NUL is the intent; see above.
const NUL = /\u0000/g;

/**
 * Strip every NUL from `text`. Applied where a tool result is built — so the
 * loop's in-memory message and the stored row agree byte-for-byte and the
 * prompt-cache prefix survives the round trip — and again where the turn is
 * written, which holds the invariant for writers that are not the loop. User
 * input needs no separate treatment: `normalizeUnicode` already strips NUL along
 * with the rest of the C0 range.
 */
export function stripNulCharacters(text: string): string {
    return text.replace(NUL, "");
}

/**
 * Each entry redacts one structured, prefixed secret format. Every pattern
 * has a prefix (`AKIA`, `sk-`, `gh*_`, `eyJ`, `Bearer`, a DB scheme) that
 * cannot collide with a nucleotide or protein sequence — so none of these
 * false-positive on biological data.
 *
 * The 40-char generic AWS secret pattern and the loose `key:value` "Generic
 * Secret Assignment" pattern are intentionally absent — both are domain-blind
 * and false-positive on nucleotide / protein sequences.
 *
 * Order matters: `sk-ant-` is redacted before the generic `sk-` so the
 * Anthropic label wins; `sk-(?!ant-)` additionally excludes it by lookahead.
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
    { name: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: "Anthropic API Key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
    { name: "OpenAI API Key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
    { name: "GitHub Token", pattern: /\bgh[psoru]_[A-Za-z0-9_]{36,}\b/g },
    {
        name: "JWT Token",
        pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    },
    { name: "Bearer Token", pattern: /\bBearer\s+[A-Za-z0-9_\-.~+/]+=*/gi },
    {
        name: "Connection String",
        pattern: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp|mssql):\/\/[^\s"'`]+/gi,
    },
];

/**
 * Replace structured secret formats with `[REDACTED: <name>]`.
 *
 * Only prefixed formats are matched — a 40-nucleotide `ACGT…` string or a
 * 40-residue protein sequence passes through unchanged.
 */
export function redactSecrets(text: string): string {
    let out = text;
    for (const { name, pattern } of SECRET_PATTERNS) {
        out = out.replace(pattern, `[REDACTED: ${name}]`);
    }
    return out;
}
