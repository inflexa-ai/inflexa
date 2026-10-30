/**
 * Input sanitization — pure, always-on text functions, not a plug-in pipeline.
 * What runs is exactly what is declared here.
 *
 * `normalizeUnicode` and `redactSecrets` are applied once to the incoming user
 * message by the chat route (change 6), and never to assistant messages or tool
 * results. `stripNulCharacters` is the exception — it applies to tool results.
 */

import { isUnknownArray } from "./lib/unknown-array.js";
import { parseUnknownRecord } from "./lib/unknown-containers.js";

/**
 * C0/C1 control characters and DEL, excluding `\t` (U+0009) and `\n`
 * (U+000A) which are legitimate whitespace in user prose.
 */
// oxlint-disable-next-line no-control-regex, eslint-js/no-restricted-syntax -- matching control characters is the intent: this pattern strips invisible C0/C1 bytes and DEL from untrusted user input (see `normalizeUnicode` below).
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
// oxlint-disable-next-line no-control-regex, eslint-js/no-restricted-syntax -- matching NUL is the intent; see above.
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
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the AWS access-key format with its fixed AKIA prefix and 16-character id body.
    { name: "AWS Access Key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the Anthropic key format with its sk-ant- prefix and base64url body.
    { name: "Anthropic API Key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the generic OpenAI sk- format; the (?!ant-) lookahead keeps the Anthropic label ahead of it.
    { name: "OpenAI API Key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the GitHub token format with its gh*_ prefix and 36-character body.
    { name: "GitHub Token", pattern: /\bgh[psoru]_[A-Za-z0-9_]{36,}\b/g },
    {
        name: "JWT Token",
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the three dot-separated base64url JWT segments after the eyJ signature prefix.
        pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    },
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the Bearer scheme with its token characters and padding, the header form of a leaked credential.
    { name: "Bearer Token", pattern: /\bBearer\s+[A-Za-z0-9_\-.~+/]+=*/gi },
    {
        name: "Connection String",
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the DB connection schemes with their :// and unquoted authority, the connection-string form of a leaked credential.
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

/**
 * The words that end the name of a field that holds a secret. A name is compared with the case, `_`, and `-` removed.
 * The name must END with the word, not hold it: `max_tokens`, `tokenizer`, and `tokenCount` hold no secret.
 */
const SECRET_NAME_WORDS: readonly string[] = [
    "password",
    "passwd",
    "secret",
    "secretkey",
    "token",
    "apikey",
    "accesskey",
    "privatekey",
    "credential",
    "credentials",
    "authorization",
];

function isSecretName(name: string): boolean {
    const folded = name.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    return SECRET_NAME_WORDS.some((word) => folded.endsWith(word));
}

const SECRET_FIELD_MARKER = "[REDACTED: Secret Field]";
const SECRET_ASSIGNMENT_MARKER = "[REDACTED: Secret Assignment]";

/**
 * A copy of a JSON value in which the value of each object field with a secret name is the redaction marker. The
 * walk goes to each depth, thus the `GITHUB_TOKEN` field of an `env` object is found. The rule belongs to the values
 * of a tool call only. `redactSecrets` stays free of any name-based rule, because a user message holds prose and
 * sequences that such a rule would mark.
 */
export function redactSecretFields(value: unknown): unknown {
    if (isUnknownArray(value)) return value.map(redactSecretFields);
    const record = parseUnknownRecord(value);
    if (record === undefined) return value;
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(record)) {
        out[name] = isSecretName(name) && field !== null && field !== undefined ? SECRET_FIELD_MARKER : redactSecretFields(field);
    }
    return out;
}

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the shell and environment form NAME=value, with a quoted value that ends at its closing quote (an escaped quote inside a double-quoted value does not end it) or a value up to the next separator. A quote that does not close holds the rest of the text, because a cut text can end inside a secret. A value does not start with `=`, thus a comparison `token == x` stays whole.
const ASSIGNMENT = /([A-Za-z0-9_.-]+)=(?!=)("(?:[^"\\]|\\.)*(?:"|\\?$)|'[^']*(?:'|$)|[^\s"'\\&;,]+)/g;

// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a quoted JSON field with a string value, `"name": "value"`. The value ends at its closing quote, and an escaped quote inside it does not end it. A quote that does not close holds the rest of the text.
const QUOTED_FIELD = /"([^"\\\s]{1,80})"(\s*:\s*)"((?:[^"\\]|\\.)*)(?:"|\\?$)/g;

/**
 * Replace the value of each `NAME=value` assignment and of each quoted `"name": "value"` field whose name ends with a
 * secret word. A caller runs it on a plain text or on one string of a JSON value, never on serialized JSON, because a
 * JSON escape hides the quotes that the rules read. It runs on the text of a tool call value only. See
 * {@link redactSecretFields}.
 */
export function redactSecretAssignments(text: string): string {
    return text
        .replace(ASSIGNMENT, (whole, name: string) => (isSecretName(name) ? `${name}=${SECRET_ASSIGNMENT_MARKER}` : whole))
        .replace(QUOTED_FIELD, (whole, name: string, colon: string) => (isSecretName(name) ? `"${name}"${colon}"${SECRET_FIELD_MARKER}"` : whole));
}
